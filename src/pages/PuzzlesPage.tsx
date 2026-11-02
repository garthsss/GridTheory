import { Chess } from 'chess.js';
import { ExternalLink, Lightbulb, RotateCcw, SkipForward, Timer, Trophy } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Board, type Arrow } from '../components/Board';
import { ClockFace, LiveRegion, MoveInput } from '../components/ui';
import { moveToUci, turnOf, uciToMove, type SimpleMove } from '../lib/chess';
import { useClock, type TimeControl } from '../lib/clock';
import { moveSound, playSound } from '../lib/sound';
import { bumpPlan, loadPuzzleRating, loadRushBest, loadSeenPuzzles, logEvents, markPuzzleSeen, savePuzzleRating, saveRushBest } from '../training/activity';
import { THEME_FILTERS, expectedScore, isCorrectMove, loadPuzzles, pickPuzzle, updatePuzzleRating, type Puzzle } from '../training/puzzles';
import { eventsFromPuzzle } from '../training/skills';

const RUSH_CONTROL: TimeControl = { id: 'rush', label: '', category: '', seconds: 180, increment: 0 };
const RUSH_STRIKES = 3;

type State = 'playing' | 'solved' | 'failed';

/** Plays one puzzle: the opponent's setup move, then the solver's moves and scripted replies. */
function usePuzzleRun(puzzle: Puzzle | null, onFinish: (solved: boolean) => void) {
  const [position, setFen] = useState(puzzle?.fen ?? '');
  // The effect below resets this hook after a render, so until then the old position belongs to the old puzzle.
  const [owner, setOwner] = useState<string | null>(puzzle?.id ?? null);
  const fen = puzzle && owner !== puzzle.id ? puzzle.fen : position;
  const [ply, setPly] = useState(0);
  const [state, setState] = useState<State>('playing');
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [mistakes, setMistakes] = useState(0);
  const [hintSquare, setHintSquare] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [announce, setAnnounce] = useState('');
  const timers = useRef<number[]>([]);
  const reported = useRef(false);

  const schedule = useCallback((run: () => void, ms: number) => {
    timers.current.push(window.setTimeout(run, ms));
  }, []);

  const playScripted = useCallback((position: string, uci: string, nextPly: number) => {
    const chess = new Chess(position);
    const move = chess.move(uciToMove(uci));
    playSound(moveSound(move.san));
    setFen(chess.fen());
    setLastMove({ from: move.from, to: move.to });
    setPly(nextPly);
    setHintSquare(null);
    setAnnounce(`Opponent played ${move.san}. Your move.`);
  }, []);

  useEffect(() => {
    timers.current.forEach(window.clearTimeout);
    timers.current = [];
    reported.current = false;
    if (!puzzle) return;
    setOwner(puzzle.id);
    setFen(puzzle.fen);
    setPly(0);
    setState('playing');
    setLastMove(null);
    setMistakes(0);
    setHintSquare(null);
    setRevealed(false);
    schedule(() => playScripted(puzzle.fen, puzzle.moves[0], 1), 350);
    return () => {
      timers.current.forEach(window.clearTimeout);
    };
  }, [puzzle, playScripted, schedule]);

  function report(solved: boolean) {
    if (reported.current) return;
    reported.current = true;
    onFinish(solved);
  }

  function play(move: SimpleMove) {
    if (!puzzle || state !== 'playing' || ply % 2 === 0) return;
    const expected = puzzle.moves[ply];
    const uci = moveToUci(move);
    if (!isCorrectMove(fen, expected, uci)) {
      playSound('wrong');
      setMistakes((n) => n + 1);
      setAnnounce('Not the move.');
      report(false);
      return;
    }
    const chess = new Chess(fen);
    const played = chess.move(move);
    playSound(moveSound(played.san));
    setFen(chess.fen());
    setLastMove({ from: played.from, to: played.to });
    setHintSquare(null);
    const nextPly = ply + 1;
    if (nextPly >= puzzle.moves.length || chess.isCheckmate()) {
      setState('solved');
      playSound('correct');
      setAnnounce('Solved.');
      report(true);
      return;
    }
    setPly(nextPly);
    const position = chess.fen();
    schedule(() => playScripted(position, puzzle.moves[nextPly], nextPly + 1), 280);
  }

  function hint() {
    if (!puzzle || ply % 2 === 0) return;
    setHintSquare(uciToMove(puzzle.moves[ply]).from);
    report(false);
  }

  function reveal() {
    if (!puzzle) return;
    setRevealed(true);
    report(false);
  }

  /** Steps through the rest of the solution, for a puzzle you've given up on. */
  function showSolution() {
    if (!puzzle) return;
    report(false);
    setState('failed');
    let current = fen;
    puzzle.moves.slice(ply).forEach((uci, index) => {
      schedule(() => {
        const chess = new Chess(current);
        const move = chess.move(uciToMove(uci));
        current = chess.fen();
        playSound(moveSound(move.san));
        setFen(current);
        setLastMove({ from: move.from, to: move.to });
      }, 500 * (index + 1));
    });
  }

  const arrows: Arrow[] = [];
  if (revealed && puzzle && state === 'playing' && ply % 2 === 1) {
    const best = uciToMove(puzzle.moves[ply]);
    arrows.push({ from: best.from, to: best.to, tone: 'good' });
  }

  return { fen, ply, state, lastMove, mistakes, hintSquare, arrows, announce, play, hint, reveal, showSolution };
}

function solverColor(puzzle: Puzzle) {
  return turnOf(puzzle.fen) === 'w' ? 'b' : 'w';
}

const solverMoves = (puzzle: Puzzle) => Math.floor(puzzle.moves.length / 2);

function PuzzleBoard({ puzzle, run }: { puzzle: Puzzle; run: ReturnType<typeof usePuzzleRun> }) {
  const color = solverColor(puzzle);
  const yourTurn = run.state === 'playing' && run.ply % 2 === 1 && turnOf(run.fen) === color;
  return (
    <Board
      fen={run.fen}
      orientation={color}
      movable={yourTurn ? color : null}
      onMove={run.play}
      lastMove={run.lastMove}
      arrows={run.arrows}
      highlight={run.hintSquare}
      label="Puzzle position"
    />
  );
}

function Rated({ filterId, onFilter }: { filterId: string; onFilter: (id: string) => void }) {
  const [puzzles, setPuzzles] = useState<Puzzle[] | null>(null);
  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
  const [rating, setRating] = useState(loadPuzzleRating);
  const [change, setChange] = useState<number | null>(null);
  const [session, setSession] = useState({ solved: 0, attempted: 0 });
  const [error, setError] = useState<string | null>(null);
  const filter = THEME_FILTERS.find((item) => item.id === filterId) ?? THEME_FILTERS[0];
  const startTime = useRef(0);

  const next = useCallback((all: Puzzle[], target: number) => {
    setChange(null);
    setPuzzle(pickPuzzle(all, target, loadSeenPuzzles(), filter.themes));
    startTime.current = Date.now();
  }, [filter]);

  useEffect(() => {
    loadPuzzles().then(
      (all) => {
        setPuzzles(all);
        next(all, loadPuzzleRating().value);
      },
      () => setError('The puzzles could not be loaded. Reload the page, as GridTheory may have just been updated.'),
    );
  }, [next]);

  function finish(solved: boolean) {
    if (!puzzle) return;
    const current = loadPuzzleRating();
    const updated = updatePuzzleRating(current, puzzle.rating, solved);
    savePuzzleRating(updated);
    setRating(updated);
    setChange(updated.value - current.value);
    markPuzzleSeen(puzzle.id);
    logEvents(eventsFromPuzzle(puzzle.themes, solverMoves(puzzle), solved, expectedScore(current.value, puzzle.rating), Date.now()));
    bumpPlan('puzzles');
    setSession((s) => ({ solved: s.solved + (solved ? 1 : 0), attempted: s.attempted + 1 }));
  }

  const run = usePuzzleRun(puzzle, finish);
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!puzzles || !puzzle) return <p className="muted">Loading puzzles…</p>;

  const settled = change !== null;
  const color = solverColor(puzzle);

  return (
    <div className="game">
      <LiveRegion text={run.announce} />
      <div className="game-board"><PuzzleBoard puzzle={puzzle} run={run} /></div>
      <aside className="panel">
        <div className="rating-card">
          <div>
            <span className="meter-label">Puzzle rating</span>
            <strong className="big-number">{rating.value}</strong>
            {change !== null && <span className={change >= 0 ? 'rating-up' : 'rating-down'}> {change >= 0 ? '+' : ''}{change}</span>}
          </div>
          <div className="right">
            <span className="meter-label">This session</span>
            <strong className="big-number">{session.solved}<small>/{session.attempted}</small></strong>
          </div>
        </div>
        <label>
          <span className="time-label">Theme</span>
          <select value={filter.id} onChange={(event) => onFilter(event.target.value)}>
            {THEME_FILTERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>

        <p className="status" role="status">
          {run.state === 'solved'
            ? 'Solved!'
            : run.state === 'failed'
              ? 'Here is the solution.'
              : run.ply === 0
                ? 'Your opponent moves first…'
                : run.mistakes
                  ? 'Not that one. Try again, or see the solution.'
                  : `Find the best move for ${color === 'w' ? 'White' : 'Black'}.`}
        </p>

        <div className="btn-row">
          {run.state === 'playing' ? (
            <>
              <button type="button" className="btn" onClick={run.hint}><Lightbulb size={16} aria-hidden="true" />Hint</button>
              <button type="button" className="btn" onClick={run.showSolution}>Show solution</button>
              <button type="button" className="btn btn-quiet" onClick={() => { run.reveal(); }}>Show next move</button>
            </>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => next(puzzles, loadPuzzleRating().value)}>
              <SkipForward size={16} aria-hidden="true" />Next puzzle
            </button>
          )}
        </div>
        {settled && (
          <p className="small muted">
            Rated {puzzle.rating}. <a href={`https://lichess.org/training/${puzzle.id}`} target="_blank" rel="noreferrer">See on Lichess <ExternalLink size={12} aria-hidden="true" /></a>
          </p>
        )}
        <MoveInput fen={run.fen} disabled={run.state !== 'playing' || run.ply % 2 === 0} onMove={(from, to, promotion) => run.play({ from, to, promotion } as SimpleMove)} />
        <p className="small muted">Using a hint, or a wrong first try, counts as a miss for your rating. You can still finish the puzzle.</p>
      </aside>
    </div>
  );
}

function Rush() {
  const [puzzles, setPuzzles] = useState<Puzzle[] | null>(null);
  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
  const [started, setStarted] = useState(false);
  const [score, setScore] = useState(0);
  const [strikes, setStrikes] = useState(0);
  const [over, setOver] = useState<string | null>(null);
  const seen = useRef(new Set<string>());
  const best = useMemo(() => loadRushBest(), [over]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void loadPuzzles().then(setPuzzles);
  }, []);

  function end(reason: string, finalScore: number) {
    clock.pause();
    setOver(reason);
    setPuzzle(null);
    saveRushBest(finalScore);
    playSound('end');
  }

  const clock = useClock(RUSH_CONTROL, () => end("Time's up.", score));

  function nextPuzzle(all: Puzzle[], solved: number) {
    // Difficulty climbs with each solved puzzle, from easy to hard.
    const picked = pickPuzzle(all, 500 + solved * 90, seen.current);
    if (picked) seen.current.add(picked.id);
    setPuzzle(picked);
  }

  function start() {
    if (!puzzles) return;
    seen.current = new Set();
    setScore(0);
    setStrikes(0);
    setOver(null);
    setStarted(true);
    clock.restore({ w: RUSH_CONTROL.seconds * 1000, b: RUSH_CONTROL.seconds * 1000 });
    clock.start('w');
    nextPuzzle(puzzles, 0);
  }

  function finish(solved: boolean) {
    if (!puzzles) return;
    if (solved) {
      const nextScore = score + 1;
      setScore(nextScore);
      window.setTimeout(() => nextPuzzle(puzzles, nextScore), 300);
    } else {
      const nextStrikes = strikes + 1;
      setStrikes(nextStrikes);
      if (nextStrikes >= RUSH_STRIKES) end('Three strikes.', score);
      else window.setTimeout(() => nextPuzzle(puzzles, score), 300);
    }
  }

  const run = usePuzzleRun(puzzle, finish);

  if (!started || over) {
    return (
      <div className="rush-start">
        <Timer size={32} aria-hidden="true" />
        <h2>{over ?? 'Puzzle Rush'}</h2>
        {over ? <p>You solved <strong>{score}</strong> {score === 1 ? 'puzzle' : 'puzzles'}.</p> : <p>Three minutes, three strikes, and the puzzles keep getting harder. Rush doesn't affect your rating.</p>}
        <p className="rush-best"><Trophy size={16} aria-hidden="true" /> Best score: {best}</p>
        <button type="button" className="btn btn-primary btn-large" onClick={start} disabled={!puzzles}>
          <RotateCcw size={18} aria-hidden="true" />{over ? 'Go again' : 'Start'}
        </button>
      </div>
    );
  }
  if (!puzzle) return <p className="muted">Loading…</p>;
  return (
    <div className="game">
      <LiveRegion text={run.announce} />
      <div className="game-board"><PuzzleBoard puzzle={puzzle} run={run} /></div>
      <aside className="panel">
        <div className="rating-card">
          <div><span className="meter-label">Solved</span><strong className="big-number">{score}</strong></div>
          <ClockFace ms={clock.times.w} active={clock.active === 'w'} label="Rush" />
        </div>
        <div className="strikes" role="img" aria-label={`${strikes} of ${RUSH_STRIKES} strikes used`}>
          {Array.from({ length: RUSH_STRIKES }, (_, i) => <span key={i} className={i < strikes ? 'strike strike-on' : 'strike'} />)}
        </div>
        <p className="status" role="status">{run.ply === 0 ? 'Your opponent moves first…' : `Find the best move for ${solverColor(puzzle) === 'w' ? 'White' : 'Black'}.`}</p>
        <MoveInput fen={run.fen} disabled={run.ply % 2 === 0} onMove={(from, to, promotion) => run.play({ from, to, promotion } as SimpleMove)} />
        <button type="button" className="btn btn-quiet" onClick={() => end('Stopped.', score)}>Stop</button>
      </aside>
    </div>
  );
}

export function PuzzlesPage({ filter }: { filter?: string }) {
  const isRush = filter === 'rush';
  return (
    <>
      <div className="mode-switch segmented" role="group" aria-label="Puzzle mode">
        <a href="#/train/puzzles/all" aria-current={!isRush ? 'true' : undefined}>Rated</a>
        <a href="#/train/puzzles/rush" aria-current={isRush ? 'true' : undefined}>Rush</a>
      </div>
      {isRush ? <Rush /> : <Rated filterId={filter ?? 'all'} onFilter={(id) => { window.location.hash = `#/train/puzzles/${id}`; }} />}
    </>
  );
}
