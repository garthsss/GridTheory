import { Chess } from 'chess.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Board, type Arrow } from '../components/Board';
import { ClassBadge, ClockFace, LiveRegion, MoveInput, MoveList } from '../components/ui';
import type { MoveReport } from '../coach/explain';
import { verifiedReport } from '../coach/verify';
import { botById, botMove, prepareBot } from '../engine/bots';
import { moveAccuracy, scoreOf, winPercentFor } from '../engine/score';
import { analysisEngine } from '../engine/uci';
import { GameSession } from '../core/session';
import { moveToUci, turnOf, uciToMove, type SimpleMove } from '../lib/chess';
import { useClock, type TimeControl } from '../lib/clock';
import { moveSound, playSound } from '../lib/sound';
import { loadProfile, loadTrainingStats, newId, saveGame, saveTrainingStats, type PhaseStats } from '../lib/storage';
import { bumpPlan, logEvents } from '../training/activity';
import { generateScenario, judgeOutcome, type Outcome, type Phase, type Scenario } from '../training/scenarios';
import { eventsFromScenario } from '../training/skills';
import { DrillsPage } from './DrillsPage';
import { PuzzlesPage } from './PuzzlesPage';

const PHASES: { id: Phase | 'mixed'; label: string; text: string }[] = [
  { id: 'opening', label: 'Opening', text: 'A random position from a named opening. Develop soundly for six moves.' },
  { id: 'middlegame', label: 'Middlegame', text: 'A position reached by engine play, sometimes with one critical move to find.' },
  { id: 'endgame', label: 'Endgame', text: 'Randomly placed pieces. Win or hold against full-strength Stockfish.' },
  { id: 'mixed', label: 'Mixed', text: 'Any of the three, chosen at random.' },
];

const OPPONENTS = [
  { id: 'sf1320', label: 'Easier' },
  { id: 'sf1600', label: 'Club' },
  { id: 'sf1900', label: 'Strong' },
  { id: 'sf2200', label: 'Master' },
  { id: 'sfmax', label: 'Maximum' },
];

const TIMERS = [
  { seconds: 0, label: 'Off' },
  { seconds: 60, label: '1 min' },
  { seconds: 180, label: '3 min' },
  { seconds: 300, label: '5 min' },
];

function recordStats(phase: Phase, passed: boolean, accuracy: number) {
  const stats = loadTrainingStats();
  const current: PhaseStats = stats[phase] ?? { attempts: 0, passed: 0, accuracySum: 0 };
  const streak = passed ? (current.streak ?? 0) + 1 : 0;
  stats[phase] = {
    attempts: current.attempts + 1,
    passed: current.passed + (passed ? 1 : 0),
    accuracySum: current.accuracySum + accuracy,
    streak,
    best: Math.max(current.best ?? 0, streak),
  };
  saveTrainingStats(stats);
}

const search = (fen: string, depth: number, multipv: number) => analysisEngine.search(fen, { depth, multipv });

function Session({ scenario, opponentId, timerSeconds, onNext, onExit }: { scenario: Scenario; opponentId: string; timerSeconds: number; onNext: () => void; onExit: () => void }) {
  const bot = botById(scenario.phase === 'endgame' ? 'sfmax' : opponentId);
  const chessRef = useRef(new GameSession(scenario.fen));
  const [fen, setFen] = useState(scenario.fen);
  const [sans, setSans] = useState<string[]>([]);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [busy, setBusy] = useState<'checking' | 'opponent' | null>(null);
  const [report, setReport] = useState<MoveReport | null>(null);
  const [awaitingChoice, setAwaitingChoice] = useState(false);
  const [showBest, setShowBest] = useState(false);
  const [win, setWin] = useState(scenario.startWin);
  const [movesPlayed, setMovesPlayed] = useState(0);
  const [outcome, setOutcome] = useState<(Outcome & { accuracy: number; gameId: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState(scenario.brief);

  const graded = useRef<number[]>([]);
  const blunders = useRef(0);
  const criticalSolved = useRef(false);
  const retrying = useRef(false);
  const alive = useRef(true);
  const startMove = useMemo(() => Number(scenario.fen.split(' ')[5]), [scenario.fen]);
  const blackFirst = scenario.fen.split(' ')[1] === 'b';

  const control: TimeControl | null = useMemo(
    () => (timerSeconds ? { id: 'train', label: '', category: '', seconds: timerSeconds, increment: 0 } : null),
    [timerSeconds],
  );
  const clock = useClock(control, () => {
    void finish(undefined, undefined, { success: false, summary: 'You ran out of time. Try a longer timer, or play this phase untimed first.' });
  });

  useEffect(() => {
    alive.current = true;
    void prepareBot(bot).catch((err) => setError(String(err)));
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const accuracy = () =>
    graded.current.length ? graded.current.reduce((a, b) => a + b, 0) / graded.current.length : 100;

  function sync() {
    const chess = chessRef.current;
    setFen(chess.fen());
    setSans(chess.history());
    const last = chess.history({ verbose: true }).at(-1);
    setLastMove(last ? { from: last.from, to: last.to } : null);
  }

  async function finish(result?: string, reason?: string, override?: Outcome) {
    clock.pause();
    const finalFen = chessRef.current.fen();
    const analysis = await analysisEngine.search(finalFen, { depth: 12 });
    const finalWin = winPercentFor(scoreOf(analysis, turnOf(finalFen)), scenario.playerColor);
    setWin(finalWin);
    const judged = override ?? judgeOutcome(scenario, finalWin, accuracy(), blunders.current, { result, reason }, criticalSolved.current);
    recordStats(scenario.phase, judged.success, accuracy());
    if (graded.current.length > 0) logEvents(eventsFromScenario(scenario.phase, accuracy(), Date.now()));
    bumpPlan('scenario');
    playSound(judged.success ? 'correct' : 'wrong');
    setAnnounce(`Scenario complete. ${judged.success ? 'Passed.' : 'Not passed.'} ${judged.summary}`);

    const chess = chessRef.current;
    const me = loadProfile().name;
    const white = scenario.playerColor === 'w' ? me : bot.name;
    const black = scenario.playerColor === 'b' ? me : bot.name;
    const pgn = chess.pgn({
      Event: `GridTheory training: ${scenario.title}`,
      Date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
      White: white,
      Black: black,
      Result: result ?? '*',
    });
    const played = chess.history().length > 0;
    const gameId = played ? newId() : '';
    if (played) {
      saveGame({
        id: gameId,
        date: new Date().toISOString(),
        pgn,
        white,
        black,
        result: result ?? '*',
        source: 'training',
        playerColor: scenario.playerColor,
      });
    }
    setOutcome({ ...judged, accuracy: accuracy(), gameId });
  }

  async function afterPlayerMove(played: number) {
    const status = chessRef.current.status();
    if (status.over) {
      await finish(status.result, status.reason);
      return;
    }
    if (played >= scenario.maxPlayerMoves) {
      await finish();
      return;
    }
    setBusy('opponent');
    try {
      const uci = await botMove(bot, chessRef.current.fen());
      if (!alive.current) return;
      const move = chessRef.current.move(uciToMove(uci));
      playSound(moveSound(move.san));
      setAnnounce(`Opponent played ${move.san}.`);
      sync();
      const next = chessRef.current.status();
      if (next.over) await finish(next.result, next.reason);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function onMove(move: SimpleMove) {
    const fenBefore = chessRef.current.fen();
    const probe = new Chess(fenBefore);
    const san = probe.move(move).san;
    // Show the move straight away while the engine grades it in the background.
    chessRef.current.move(move);
    playSound(moveSound(san));
    sync();
    setBusy('checking');
    setShowBest(false);
    try {
      const [before, after] = await Promise.all([
        analysisEngine.search(fenBefore, { depth: 13, multipv: 1 }),
        analysisEngine.search(probe.fen(), { depth: 13, multipv: 1 }),
      ]);
      if (!alive.current) return;
      const next = await verifiedReport(fenBefore, probe.fen(), moveToUci(move), before, after, 13);
      if (!alive.current) return;
      setReport(next);
      setWin(next.winAfter);
      setAnnounce(next.headline || `${next.san}: ${next.cls}.`);
      if (!retrying.current) {
        graded.current.push(moveAccuracy(next.loss));
        if (next.cls === 'blunder') blunders.current++;
        if (movesPlayed === 0 && scenario.critical && (next.cls === 'brilliant' || next.cls === 'best' || next.cls === 'good')) {
          criticalSolved.current = true;
        }
      }
      if (next.cls === 'mistake' || next.cls === 'blunder') {
        playSound('wrong');
        setAwaitingChoice(true);
        setBusy(null);
        return;
      }
      retrying.current = false;
      const played = movesPlayed + 1;
      setMovesPlayed(played);
      await afterPlayerMove(played);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function retry() {
    chessRef.current.undo();
    retrying.current = true;
    setAwaitingChoice(false);
    setReport(null);
    setShowBest(false);
    sync();
    const position = chessRef.current.fen();
    void analysisEngine.search(position, { depth: 13 }).then((analysis) => {
      if (alive.current) setWin(winPercentFor(scoreOf(analysis, turnOf(position)), scenario.playerColor));
    });
  }

  function playOn() {
    setAwaitingChoice(false);
    retrying.current = false;
    const played = movesPlayed + 1;
    setMovesPlayed(played);
    void afterPlayerMove(played);
  }

  const arrows: Arrow[] = [];
  if (report && awaitingChoice && report.replyUci) {
    const reply = uciToMove(report.replyUci);
    arrows.push({ from: reply.from, to: reply.to, tone: 'bad' });
  }
  if (report && showBest && report.bestUci) {
    const best = uciToMove(report.bestUci);
    arrows.push({ from: best.from, to: best.to, tone: 'good' });
  }

  const canMove = !busy && !awaitingChoice && !outcome && chessRef.current.turn() === scenario.playerColor;

  // The timer only counts your own thinking, not the grading or the opponent.
  useEffect(() => {
    if (canMove) clock.start(scenario.playerColor);
    else clock.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canMove]);

  const left = Math.max(0, scenario.maxPlayerMoves - movesPlayed);

  return (
    <div className="game">
      <LiveRegion text={announce} />
      <div className="game-board">
        <Board
          fen={showBest && report ? report.fenBefore : fen}
          orientation={scenario.playerColor}
          movable={canMove ? scenario.playerColor : null}
          onMove={(move) => void onMove(move)}
          lastMove={showBest ? null : lastMove}
          arrows={arrows}
          label={`Training position: ${scenario.title}`}
        />
      </div>
      <aside className="panel">
        <div className="train-head">
          <span className="phase-tag">{scenario.phase}</span>
          {control && <ClockFace ms={clock.times[scenario.playerColor]} active={clock.active === scenario.playerColor} label="Your" />}
        </div>
        <h1 className="train-title">{scenario.title}</h1>
        <p>{scenario.brief}</p>

        <div className="meters">
          <div>
            <div className="meter-top">
              <span className="meter-label">Your win chance</span>
              <span className="meter-value">{Math.round(win)}%</span>
            </div>
            <div className="meter" role="progressbar" aria-label="Your win chance" aria-valuenow={Math.round(win)} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${win}%` }} />
            </div>
          </div>
          <div className="meter-row">
            <span><strong>{Math.round(accuracy())}%</strong> accuracy</span>
            <span><strong>{left}</strong> {left === 1 ? 'move' : 'moves'} left</span>
          </div>
        </div>

        <p className="status" role="status">
          {outcome
            ? 'Scenario complete.'
            : busy === 'checking'
              ? 'Grading your move…'
              : busy === 'opponent'
                ? `${bot.name} is replying…`
                : awaitingChoice
                  ? 'Choose how to continue.'
                  : 'Your move.'}
        </p>
        {error && <p className="error">{error}</p>}

        {report && (
          <div className={`move-note move-note-${report.cls}`}>
            <p><ClassBadge cls={report.cls} /> <strong>{report.san}</strong></p>
            {report.headline ? (
              <>
                <p><strong>{report.headline}</strong></p>
                <p className="small">{report.detail}</p>
              </>
            ) : (
              <p className="small">{report.cls === 'best' ? "That's the engine's top choice." : 'A good move, close to the best.'}</p>
            )}
            {awaitingChoice && (
              <div className="btn-row">
                <button type="button" className="btn btn-primary" onClick={retry}>Retry this move</button>
                <button type="button" className="btn" onClick={() => setShowBest(!showBest)}>{showBest ? 'Hide best move' : 'Show best move'}</button>
                <button type="button" className="btn btn-quiet" onClick={playOn}>Play on</button>
              </div>
            )}
          </div>
        )}

        {outcome && (
          <div className="end-card">
            <h2>{outcome.success ? 'Passed' : 'Not this time'}</h2>
            <p>{outcome.summary}</p>
            <div className="btn-row">
              <button type="button" className="btn btn-primary" onClick={onNext}>Next scenario</button>
              {outcome.gameId && <a className="btn" href={`#/review/${outcome.gameId}`}>Review it</a>}
            </div>
          </div>
        )}

        <div className="moves-card">
          <MoveList sans={sans} startNumber={startMove} blackFirst={blackFirst} />
        </div>
        {!outcome && <MoveInput fen={fen} disabled={!canMove} onMove={(from, to, promotion) => void onMove({ from, to, promotion } as SimpleMove)} />}
        <div className="btn-row">
          {!outcome && <button type="button" className="btn" onClick={onNext}>Skip scenario</button>}
          <button type="button" className="btn btn-quiet" onClick={onExit}>Back to phases</button>
        </div>
      </aside>
    </div>
  );
}

const TRAIN_VIEWS = [
  { id: 'scenarios', label: 'Scenarios', href: '#/train' },
  { id: 'puzzles', label: 'Puzzles', href: '#/train/puzzles/all' },
  { id: 'drills', label: 'My mistakes', href: '#/train/drills' },
];

export function TrainPage({ view = 'scenarios', detail }: { view?: string; detail?: string }) {
  return (
    <div className="train">
      <nav className="subnav" aria-label="Training">
        {TRAIN_VIEWS.map((item) => (
          <a key={item.id} href={item.href} aria-current={view === item.id ? 'page' : undefined}>{item.label}</a>
        ))}
      </nav>
      {view === 'puzzles' ? <PuzzlesPage key={detail} filter={detail} /> : view === 'drills' ? <DrillsPage /> : <Scenarios initial={detail} />}
    </div>
  );
}

function Scenarios({ initial }: { initial?: string }) {
  const [phase, setPhase] = useState<Phase | 'mixed'>(
    initial === 'opening' || initial === 'middlegame' || initial === 'endgame' ? initial : 'endgame',
  );
  const [opponentId, setOpponentId] = useState('sf1600');
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const stats = loadTrainingStats();

  async function load(chosen: Phase | 'mixed') {
    setLoading(true);
    setError(null);
    setScenario(null);
    try {
      const actual: Phase = chosen === 'mixed' ? (['opening', 'middlegame', 'endgame'] as const)[Math.floor(Math.random() * 3)] : chosen;
      const next = await generateScenario(actual, search);
      setScenario(next);
      setRound((r) => r + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  if (scenario) {
    return <Session key={round} scenario={scenario} opponentId={opponentId} timerSeconds={timerSeconds} onNext={() => void load(phase)} onExit={() => setScenario(null)} />;
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Scenarios</h1>
        <p className="muted">
          Every position is new, generated on your computer by Stockfish. Each move gets graded as soon as you play it, with
          the reason why, and you can retry mistakes.
        </p>
      </header>
      <div className="phase-grid">
        {PHASES.map((item) => {
          const record = item.id === 'mixed' ? undefined : stats[item.id];
          return (
            <button key={item.id} type="button" className="phase-card" aria-pressed={phase === item.id} onClick={() => setPhase(item.id)}>
              <strong>{item.label}</strong>
              <span>{item.text}</span>
              {record && (
                <span className="phase-record">
                  {record.passed}/{record.attempts} passed · {Math.round(record.accuracySum / record.attempts)}% avg
                  {record.best ? ` · best streak ${record.best}` : ''}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="train-options">
        {phase !== 'endgame' && (
          <fieldset>
            <legend>Opponent strength</legend>
            <div className="segmented">
              {OPPONENTS.map((option) => (
                <button key={option.id} type="button" aria-pressed={opponentId === option.id} onClick={() => setOpponentId(option.id)}>{option.label}</button>
              ))}
            </div>
          </fieldset>
        )}
        <fieldset>
          <legend>Timer (optional)</legend>
          <div className="segmented">
            {TIMERS.map((option) => (
              <button key={option.seconds} type="button" aria-pressed={timerSeconds === option.seconds} onClick={() => setTimerSeconds(option.seconds)}>{option.label}</button>
            ))}
          </div>
          <p className="small muted">The timer only counts your own thinking.</p>
        </fieldset>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="button" className="btn btn-primary btn-large" onClick={() => void load(phase)} disabled={loading}>
        {loading ? 'Finding a position…' : 'Start training'}
      </button>
    </div>
  );
}
