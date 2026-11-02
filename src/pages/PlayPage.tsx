import { Chess } from 'chess.js';
import { Dices, Flag, FlipVertical2, Lightbulb, Map as MapIcon, RotateCcw, ShieldAlert, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Board, type Arrow } from '../components/Board';
import { ClassBadge, ClockFace, EvalBar, LiveRegion, MaterialDiff, MoveInput, MoveList, PgnActions, PlayerBar } from '../components/ui';
import { findThreats, hintFor, positionSummary, type MoveReport } from '../coach/explain';
import { COACHES, coachById, commentaryFor, shouldStop, type Coach, type StopLevel } from '../coach/personas';
import { verifiedReport } from '../coach/verify';
import { BOTS, botById, botMove, prepareBot, ratingLabel, type Bot } from '../engine/bots';
import { formatScore, scoreOf, winPercent, type Analysis } from '../engine/score';
import { analysisEngine } from '../engine/uci';
import { COLOR_NAMES, START_FEN, moveToUci, other, turnOf, uciToMove, type SimpleMove } from '../lib/chess';
import { TIME_CONTROLS, botThinkTime, flagResult, timeControlById, useClock, type ClockState } from '../lib/clock';
import { openingFromFens } from '../lib/openings';
import { moveSound, playSound } from '../lib/sound';
import { GameSession } from '../core/session';
import { loadLastGameConfig, loadProfile, loadRating, newId, saveGame, saveLastGameConfig, updateRating } from '../lib/storage';

const COACH_DEPTH = 12;

interface Config {
  botId: string;
  color: 'w' | 'b' | 'random';
  coachId: string;
  stop: StopLevel;
  commentary: boolean;
  showEval: boolean;
  showGrades: boolean;
  time: string;
}

interface Message {
  id: number;
  text: string;
  tone: 'info' | 'warn' | 'good';
}

const gradeKey = (fenBefore: string, uci: string) => `${fenBefore}|${uci}`;

function initialsOf(name: string) {
  return name.split(' ').map((word) => word[0]).join('').slice(0, 2).toUpperCase();
}

function Setup({ onStart }: { onStart: (config: Config) => void }) {
  const rating = loadRating();
  const suggested = BOTS.reduce((best, bot) =>
    Math.abs(bot.rating - rating.value) < Math.abs(best.rating - rating.value) ? bot : best,
  );
  const [config, setConfig] = useState<Config>({
    botId: suggested.id,
    color: 'w',
    coachId: 'maren',
    stop: 'mistake',
    commentary: true,
    showEval: false,
    showGrades: false,
    time: 'none',
    ...loadLastGameConfig<Config>(),
  });
  const set = (patch: Partial<Config>) => setConfig((current) => ({ ...current, ...patch }));
  const bot = botById(config.botId);
  const categories = [...new Set(TIME_CONTROLS.map((tc) => tc.category))];

  return (
    <div className="game">
      <div className="game-board">
        <PlayerBar name={bot.name} detail={`about ${ratingLabel(bot)}`} initials={initialsOf(bot.name)} />
        <Board fen={START_FEN} orientation={config.color === 'b' ? 'b' : 'w'} label="Starting position" />
        <PlayerBar name="You" detail={`${rating.value}${rating.games < 10 ? ' (provisional)' : ''}`} initials="You" />
      </div>
      <aside className="panel setup">
        <h1>Play a bot</h1>
        <section aria-labelledby="pick-opponent">
          <h2 id="pick-opponent">Opponent</h2>
          <div className="bot-list" role="list">
            {BOTS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="bot-row"
                aria-pressed={config.botId === item.id}
                onClick={() => set({ botId: item.id })}
              >
                <span className="avatar" aria-hidden="true">{initialsOf(item.name)}</span>
                <span className="bot-text">
                  <strong>{item.name}{item.id === suggested.id && <span className="tag">Suggested</span>}</strong>
                  <span>{item.blurb}</span>
                </span>
                <span className="bot-rating">{ratingLabel(item)}</span>
              </button>
            ))}
          </div>
          <p className="small muted">Ratings come from a measured bot tournament on Stockfish's engine scale, so treat them as estimates of human strength.</p>
        </section>

        <section aria-labelledby="pick-time">
          <h2 id="pick-time">Time control</h2>
          <button type="button" className="chip chip-wide" aria-pressed={config.time === 'none'} onClick={() => set({ time: 'none' })}>No clock</button>
          {categories.map((category) => (
            <div key={category} className="time-group">
              <span className="time-label">{category}</span>
              <div className="chips">
                {TIME_CONTROLS.filter((tc) => tc.category === category).map((tc) => (
                  <button key={tc.id} type="button" className="chip" aria-pressed={config.time === tc.id} onClick={() => set({ time: tc.id })}>{tc.label}</button>
                ))}
              </div>
            </div>
          ))}
        </section>

        <section aria-labelledby="pick-colour">
          <h2 id="pick-colour">Your colour</h2>
          <div className="segmented">
            {(['w', 'random', 'b'] as const).map((color) => (
              <button key={color} type="button" aria-pressed={config.color === color} onClick={() => set({ color })}>
                {color === 'random' && <Dices size={16} aria-hidden="true" />}
                {color === 'w' ? 'White' : color === 'b' ? 'Black' : 'Random'}
              </button>
            ))}
          </div>
        </section>

        <section aria-labelledby="pick-coach">
          <h2 id="pick-coach">Coach</h2>
          <div className="coach-pick">
            <button type="button" aria-pressed={config.coachId === 'none'} onClick={() => set({ coachId: 'none', stop: 'off', commentary: false })}>
              <strong>No coach</strong>
              <span>A rated game, just you against the bot.</span>
            </button>
            {COACHES.map((coach) => (
              <button key={coach.id} type="button" aria-pressed={config.coachId === coach.id} onClick={() => set({ coachId: coach.id, stop: coach.defaultStop, commentary: true })}>
                <strong>{coach.name}, {coach.title}</strong>
                <span>{coach.blurb}</span>
              </button>
            ))}
          </div>
          {config.coachId !== 'none' && (
            <div className="coach-options">
              <span className="time-label">Correct my moves</span>
              <div className="segmented">
                {([['off', 'Never'], ['blunder', 'Blunders'], ['mistake', 'Mistakes too']] as const).map(([stop, label]) => (
                  <button key={stop} type="button" aria-pressed={config.stop === stop} onClick={() => set({ stop })}>{label}</button>
                ))}
              </div>
              <label className="check">
                <input type="checkbox" checked={config.commentary} onChange={(e) => set({ commentary: e.target.checked })} />
                Comment on moves as we play
              </label>
              <label className="check">
                <input type="checkbox" checked={config.showEval} onChange={(e) => set({ showEval: e.target.checked })} />
                Show the evaluation bar
              </label>
            </div>
          )}
        </section>

        <section aria-labelledby="pick-grades">
          <h2 id="pick-grades">Move grades</h2>
          <label className="check">
            <input type="checkbox" checked={config.showGrades} onChange={(e) => set({ showGrades: e.target.checked })} />
            Grade every move as it's played
          </label>
          <p className="small muted">Shows both sides' moves from Brilliant to Blunder during the game. Games with grades on are unrated.</p>
        </section>

        <div className="setup-cta">
          <button
            type="button"
            className="btn btn-primary btn-large"
            onClick={() => {
              saveLastGameConfig(config);
              onStart(config);
            }}
          >
            Play {bot.name}
          </button>
        </div>
      </aside>
    </div>
  );
}

function Game({ config, onExit, onRematch }: { config: Config; onExit: () => void; onRematch: () => void }) {
  const bot: Bot = botById(config.botId);
  const coach: Coach | null = coachById(config.coachId);
  const control = useMemo(() => timeControlById(config.time), [config.time]);
  const [playerColor] = useState<'w' | 'b'>(() =>
    config.color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : config.color,
  );
  const botColor = other(playerColor);
  const chessRef = useRef(new GameSession());
  const [fen, setFen] = useState(START_FEN);
  const [sans, setSans] = useState<string[]>([]);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [thinking, setThinking] = useState(false);
  const [checking, setChecking] = useState(false);
  const [intervention, setIntervention] = useState<{ move: SimpleMove; report: MoveReport; showBest: boolean } | null>(null);
  const [messages, setMessages] = useState<Message[]>(coach ? [{ id: 0, text: coach.greeting, tone: 'info' }] : []);
  const [hint, setHint] = useState<{ level: 1 | 2 | 3; square?: string; uci?: string } | null>(null);
  const [end, setEnd] = useState<{ result: string; reason: string; gameId: string; pgn: string; newRating?: number; oldRating: number } | null>(null);
  const [evalWin, setEvalWin] = useState(50);
  const [evalText, setEvalText] = useState('+0.0');
  const [error, setError] = useState<string | null>(null);
  const [flipped, setFlipped] = useState(playerColor === 'b');
  const [view, setView] = useState<number | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [grades, setGrades] = useState<Record<string, MoveReport>>({});
  const assisted = useRef(coach !== null || config.showGrades);
  const generation = useRef(0);
  const cache = useRef(new Map<string, Promise<Analysis>>());
  const messageId = useRef(1);
  const clockHistory = useRef<ClockState[]>([]);
  const warnedLow = useRef(false);

  const clock = useClock(control, (side) => {
    generation.current++;
    setThinking(false);
    setChecking(false);
    setIntervention(null);
    finish(flagResult(chessRef.current.fen(), side), `${COLOR_NAMES[side]} running out of time`);
  });

  useEffect(() => {
    if (control && !warnedLow.current && clock.times[playerColor] < 10_000 && clock.active === playerColor) {
      warnedLow.current = true;
      playSound('low');
      setAnnounce('Ten seconds left on your clock.');
    }
  }, [clock.active, clock.times, control, playerColor]);

  const analyse = (position: string) => {
    let pending = cache.current.get(position);
    if (!pending) {
      pending = analysisEngine.search(position, { depth: COACH_DEPTH, multipv: 2 });
      cache.current.set(position, pending);
    }
    return pending;
  };

  const say = (text: string, tone: Message['tone'] = 'info') => {
    setMessages((current) => [...current.slice(-30), { id: messageId.current++, text, tone }]);
  };

  function sync() {
    const chess = chessRef.current;
    setFen(chess.fen());
    setSans(chess.history());
    const last = chess.history({ verbose: true }).at(-1);
    setLastMove(last ? { from: last.from, to: last.to } : null);
    setHint(null);
    setView(null);
  }

  function finish(result: string, reason: string) {
    clock.pause();
    const chess = chessRef.current;
    const me = loadProfile().name;
    const white = playerColor === 'w' ? me : bot.name;
    const black = playerColor === 'b' ? me : bot.name;
    chess.conclude(result, reason);
    const id = newId();
    const pgn = chess.pgn({
      Event: 'GridTheory game',
      Date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
      White: white,
      Black: black,
      Result: result,
      ...(control ? { TimeControl: `${control.seconds}+${control.increment}` } : {}),
    });
    const played = chess.history().length > 0;
    if (played) saveGame({ id, date: new Date().toISOString(), pgn, white, black, result, source: 'bot', playerColor });
    const oldRating = loadRating().value;
    let newRating: number | undefined;
    if (!assisted.current && chess.history().length >= 10) {
      const score = result === '1/2-1/2' ? 0.5 : (result === '1-0') === (playerColor === 'w') ? 1 : 0;
      newRating = updateRating(bot.rating, score).value;
    }
    setEnd({ result, reason, gameId: played ? id : '', pgn, newRating, oldRating });
    playSound('end');
    setAnnounce(`Game over. ${result}, by ${reason}.`);
  }

  function checkEnd() {
    const status = chessRef.current.status();
    if (status.over) finish(status.result, status.reason);
    return status.over;
  }

  async function updateEval(position: string) {
    if (!config.showEval) return;
    const analysis = await analyse(position);
    const score = scoreOf(analysis, turnOf(position));
    setEvalWin(winPercent(score));
    setEvalText(formatScore(score));
  }

  const recordGrade = (report: MoveReport) => {
    setGrades((current) => ({ ...current, [gradeKey(report.fenBefore, report.uci)]: report }));
  };

  /** Runs in the background, so that grading never holds up the game or uses anyone's clock. */
  async function gradeMove(fenBefore: string, fenAfter: string, uci: string) {
    if (!config.showGrades) return;
    try {
      const [before, after] = await Promise.all([analyse(fenBefore), analyse(fenAfter)]);
      // Another page can cancel the engine's queue, which leaves an empty answer. Better no grade than a wrong one.
      if (before.lines.length > 0) recordGrade(await verifiedReport(fenBefore, fenAfter, uci, before, after, COACH_DEPTH));
    } catch {
      // A missing grade doesn't affect the game.
    }
  }

  async function botTurn() {
    const token = ++generation.current;
    setThinking(true);
    clock.start(botColor);
    try {
      const limit = control
        ? botThinkTime(bot.stockfish?.movetime ?? 500, clock.snapshot()[botColor], control.increment)
        : undefined;
      const uci = await botMove(bot, chessRef.current.fen(), limit);
      if (token !== generation.current) return;
      const fenBefore = chessRef.current.fen();
      const move = chessRef.current.move(uciToMove(uci));
      void gradeMove(fenBefore, chessRef.current.fen(), uci);
      clock.addIncrement(botColor);
      playSound(moveSound(move.san));
      setAnnounce(`${COLOR_NAMES[botColor]} played ${move.san}.`);
      sync();
      if (checkEnd()) return;
      clock.start(playerColor);
      const position = chessRef.current.fen();
      void updateEval(position);
      if (coach && config.commentary) {
        const threat = findThreats(position, playerColor)[0];
        if (threat) say(threat.text, 'warn');
      }
    } catch (err) {
      if (token === generation.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (token === generation.current) setThinking(false);
    }
  }

  function commit(move: SimpleMove, report: MoveReport | null) {
    const fenBefore = chessRef.current.fen();
    const played = chessRef.current.move(move);
    if (report) recordGrade(report);
    else void gradeMove(fenBefore, chessRef.current.fen(), moveToUci(move));
    // Saved before the increment, so that taking the move back doesn't keep the bonus time.
    clockHistory.current.push(clock.snapshot());
    clock.addIncrement(playerColor);
    playSound(moveSound(played.san));
    sync();
    if (report && coach && config.commentary) {
      const text = commentaryFor(coach, report, chessRef.current.history().length);
      if (text) say(text, report.cls === 'brilliant' || report.cls === 'best' || report.cls === 'good' ? 'good' : 'warn');
    }
    if (!checkEnd()) void botTurn();
  }

  async function onPlayerMove(move: SimpleMove) {
    const fenBefore = chessRef.current.fen();
    if (!coach) {
      commit(move, null);
      return;
    }
    // Your clock doesn't run while the coach is checking your move.
    clock.pause();
    setChecking(true);
    try {
      const probe = new Chess(fenBefore);
      probe.move(move);
      const token = generation.current;
      const [before, after] = await Promise.all([analyse(fenBefore), analyse(probe.fen())]);
      if (token !== generation.current) return;
      const report = await verifiedReport(fenBefore, probe.fen(), moveToUci(move), before, after, COACH_DEPTH);
      if (token !== generation.current) return;
      if (shouldStop(report, config.stop)) {
        playSound('wrong');
        setIntervention({ move, report, showBest: false });
        setAnnounce(`${coach.name} stepped in. ${report.headline}`);
      } else {
        commit(move, report);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      commit(move, null);
    } finally {
      setChecking(false);
    }
  }

  function takeBack() {
    generation.current++;
    setThinking(false);
    assisted.current = true;
    const chess = chessRef.current;
    if (chess.turn() !== playerColor) chess.undo();
    else {
      chess.undo();
      chess.undo();
    }
    const restored = clockHistory.current.pop();
    if (chess.turn() === playerColor && restored) clock.restore(restored);
    setIntervention(null);
    sync();
    void updateEval(chess.fen());
    if (chess.turn() !== playerColor) void botTurn();
    else clock.start(playerColor);
  }

  function resign() {
    generation.current++;
    setThinking(false);
    finish(playerColor === 'w' ? '0-1' : '1-0', 'resignation');
  }

  async function askHint() {
    const level = hint ? (Math.min(hint.level + 1, 3) as 1 | 2 | 3) : 1;
    assisted.current = true;
    const position = chessRef.current.fen();
    const analysis = await analyse(position);
    const next = hintFor(position, analysis, level);
    setHint({ level, square: next.square, uci: next.uci });
    say(next.text);
  }

  async function askPlan() {
    assisted.current = true;
    const position = chessRef.current.fen();
    say(positionSummary(position, playerColor, await analyse(position)));
  }

  function askThreats() {
    assisted.current = true;
    const threats = findThreats(chessRef.current.fen(), playerColor);
    say(threats.length ? threats.map((t) => t.text).join(' ') : 'No immediate threats that I can see: nothing hanging and no mate next move.', threats.length ? 'warn' : 'good');
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await prepareBot(bot);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
      if (cancelled) return;
      if (playerColor === 'b') void botTurn();
      else clock.start('w');
    })();
    return () => {
      cancelled = true;
      generation.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const history = useMemo(() => chessRef.current.history({ verbose: true }), [sans]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      const total = history.length;
      if (event.key === 'ArrowLeft') setView((v) => Math.max(0, (v ?? total) - 1));
      if (event.key === 'ArrowRight') setView((v) => (v === null || v + 1 >= total ? null : v + 1));
      if (event.key === 'f' && !event.ctrlKey && !event.metaKey) setFlipped((f) => !f);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [history.length]);

  const report = intervention?.report;
  const viewing = view !== null && view < history.length;
  const shownFen = report
    ? report.fenAfter
    : viewing
      ? (view === 0 ? START_FEN : history[view - 1].after)
      : fen;
  const shownLast = report
    ? uciToMove(report.uci)
    : viewing
      ? (view === 0 ? null : { from: history[view - 1].from, to: history[view - 1].to })
      : lastMove;

  const arrows: Arrow[] = [];
  if (report?.replyUci) {
    const reply = uciToMove(report.replyUci);
    arrows.push({ from: reply.from, to: reply.to, tone: 'bad' });
  }
  if (report && intervention?.showBest && report.bestUci) {
    const best = uciToMove(report.bestUci);
    arrows.push({ from: best.from, to: best.to, tone: 'good' });
  }
  if (hint?.uci && !viewing) {
    const best = uciToMove(hint.uci);
    arrows.push({ from: best.from, to: best.to, tone: 'good' });
  }

  const canMove = !end && !intervention && !thinking && !checking && !viewing && chessRef.current.turn() === playerColor;
  const statusText = end
    ? `Game over: ${end.result}, by ${end.reason}.`
    : checking
      ? `${coach?.name ?? 'Coach'} is looking at your move…`
      : thinking
        ? `${bot.name} is thinking…`
        : intervention
          ? `${coach?.name} stepped in.`
          : viewing
            ? 'Looking at an earlier position.'
            : `Your move, ${COLOR_NAMES[playerColor]}.`;

  const opening = openingFromFens((viewing ? history.slice(0, view) : history).map((move) => move.after));
  const gradeOf = (move: (typeof history)[number]) => grades[gradeKey(move.before, moveToUci(move))];
  const gradedMoves = viewing ? history.slice(Math.max(0, view - 1), view) : history.slice(-2);

  const topColor = flipped ? 'w' : 'b';
  const bottomColor = flipped ? 'b' : 'w';
  const bar = (color: 'w' | 'b') => {
    const isBot = color === botColor;
    return (
      <PlayerBar
        name={isBot ? bot.name : 'You'}
        detail={isBot ? `about ${ratingLabel(bot)}` : COLOR_NAMES[playerColor]}
        initials={isBot ? initialsOf(bot.name) : 'You'}
        thinking={isBot && thinking}
      >
        <MaterialDiff fen={shownFen} color={color} />
        {control && <ClockFace ms={clock.times[color]} active={clock.active === color} label={isBot ? bot.name : 'Your'} />}
      </PlayerBar>
    );
  };

  return (
    <div className="game">
      <LiveRegion text={announce} />
      <div className="game-board">
        {bar(topColor)}
        <div className="board-row">
          {config.showEval && <EvalBar win={evalWin} flipped={flipped} />}
          <Board
            fen={shownFen}
            orientation={flipped ? 'b' : 'w'}
            movable={canMove ? playerColor : null}
            onMove={(move) => void onPlayerMove(move)}
            lastMove={shownLast}
            arrows={arrows}
            highlight={hint?.square ?? null}
            label={`Game against ${bot.name}`}
          />
        </div>
        {bar(bottomColor)}
      </div>

      <aside className="panel">
        <div className="status-row">
          <p className="status" role="status">{statusText}</p>
          {config.showEval && <span className="eval-text">{evalText}</span>}
        </div>
        {opening && <p className="small muted">{opening}</p>}
        {error && <p className="error">{error}</p>}

        {intervention && report && (
          <div className="stop-card" role="alertdialog" aria-label="Coach intervention">
            <div className="stop-head">
              <ShieldAlert size={18} aria-hidden="true" />
              <ClassBadge cls={report.cls} />
              <span>{coach?.stop}</span>
            </div>
            <p><strong>{report.headline}</strong></p>
            <p className="small">{report.detail}</p>
            {intervention.showBest && <p className="small">The stronger move was <strong>{report.bestSan}</strong>.</p>}
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setIntervention(null);
                  clock.start(playerColor);
                }}
              >
                Take it back
              </button>
              {!intervention.showBest && (
                <button type="button" className="btn" onClick={() => setIntervention({ ...intervention, showBest: true })}>Show better move</button>
              )}
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  const { move } = intervention;
                  setIntervention(null);
                  commit(move, report);
                }}
              >
                Play it anyway
              </button>
            </div>
          </div>
        )}

        {end && (
          <div className="end-card">
            <h2>{end.result === '1/2-1/2' ? 'Draw' : (end.result === '1-0') === (playerColor === 'w') ? 'You won' : `${bot.name} won`}</h2>
            <p className="muted">
              By {end.reason}.
              {end.newRating !== undefined && (
                <> Rating {end.newRating} <span className={end.newRating >= end.oldRating ? 'rating-up' : 'rating-down'}>({end.newRating >= end.oldRating ? '+' : ''}{end.newRating - end.oldRating})</span>.</>
              )}
              {end.newRating === undefined && ' Unrated.'}
            </p>
            <div className="btn-row">
              {end.gameId && <a className="btn btn-primary" href={`#/review/${end.gameId}`}>Review this game</a>}
              <button type="button" className="btn" onClick={onRematch}><RotateCcw size={16} aria-hidden="true" />Rematch</button>
              <button type="button" className="btn btn-quiet" onClick={onExit}>New opponent</button>
            </div>
            {end.gameId && <PgnActions pgn={end.pgn} />}
          </div>
        )}

        {coach && !end && (
          <section className="coach-box" aria-label="Coach">
            <div className="coach-head">
              <span className="avatar avatar-coach" aria-hidden="true">{coach.name[0]}</span>
              <div><strong>{coach.name}</strong><br /><span className="small muted">{coach.title}</span></div>
            </div>
            <div className="coach-log" role="log" aria-live="polite">
              {messages.map((message) => (
                <p key={message.id} className={`coach-msg coach-${message.tone}`}>{message.text}</p>
              ))}
            </div>
            <div className="btn-row">
              <button type="button" className="btn" onClick={() => void askHint()} disabled={!canMove}>
                <Lightbulb size={16} aria-hidden="true" />{hint ? 'Stronger hint' : 'Hint'}
              </button>
              <button type="button" className="btn" onClick={askThreats} disabled={!canMove}>
                <ShieldAlert size={16} aria-hidden="true" />Any threats?
              </button>
              <button type="button" className="btn" onClick={() => void askPlan()} disabled={!canMove}>
                <MapIcon size={16} aria-hidden="true" />What's the plan?
              </button>
            </div>
          </section>
        )}

        {config.showGrades && gradedMoves.length > 0 && (
          <div aria-live="polite">
            {gradedMoves.map((move) => {
              const grade = gradeOf(move);
              return (
                <div key={move.before} className={`grade-row ${grade ? `move-note-${grade.cls}` : ''}`}>
                  <p>
                    {grade ? <ClassBadge cls={grade.cls} /> : <span className="small muted">Grading…</span>}{' '}
                    <strong>{move.san}</strong> <span className="small muted">{move.color === playerColor ? 'You' : bot.name}</span>
                  </p>
                  {/* Headlines are written to the player, so they'd read wrongly on the bot's moves. */}
                  {grade?.headline && move.color === playerColor && <p className="small">{grade.headline}</p>}
                </div>
              );
            })}
          </div>
        )}

        <div className="moves-card">
          <MoveList
            sans={sans}
            current={viewing ? (view ?? undefined) : undefined}
            onSelect={(ply) => setView(ply >= sans.length ? null : ply)}
            classes={config.showGrades ? history.map((move) => gradeOf(move)?.cls) : undefined}
          />
          {viewing && <button type="button" className="btn btn-quiet back-live" onClick={() => setView(null)}>Back to the game</button>}
        </div>

        {!end && <MoveInput fen={fen} disabled={!canMove} onMove={(from, to, promotion) => void onPlayerMove({ from, to, promotion } as SimpleMove)} />}

        <div className="btn-row game-actions">
          {!end && (
            <>
              <button type="button" className="btn" onClick={takeBack} disabled={sans.length === 0 || checking || !!intervention}>
                <Undo2 size={16} aria-hidden="true" />Take back
              </button>
              {confirmResign ? (
                <>
                  <button type="button" className="btn btn-danger" onClick={resign}>Confirm resign</button>
                  <button type="button" className="btn btn-quiet" onClick={() => setConfirmResign(false)}>Keep playing</button>
                </>
              ) : (
                <button type="button" className="btn" onClick={() => setConfirmResign(true)}>
                  <Flag size={16} aria-hidden="true" />Resign
                </button>
              )}
            </>
          )}
          <button type="button" className="btn btn-quiet" onClick={() => setFlipped(!flipped)}>
            <FlipVertical2 size={16} aria-hidden="true" />Flip
          </button>
          {!end && <button type="button" className="btn btn-quiet" onClick={onExit}>Leave</button>}
        </div>
      </aside>
    </div>
  );
}

export function PlayPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [gameKey, setGameKey] = useState(0);
  if (!config) return <Setup onStart={(next) => { setConfig(next); setGameKey((k) => k + 1); }} />;
  return <Game key={gameKey} config={config} onExit={() => setConfig(null)} onRematch={() => setGameKey((k) => k + 1)} />;
}
