import { Chess } from 'chess.js';
import { CheckCircle2, Repeat } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Board, type Arrow } from '../components/Board';
import { LiveRegion, MoveInput } from '../components/ui';
import { scoreOf, winPercentFor } from '../engine/score';
import { analysisEngine } from '../engine/uci';
import { moveToUci, turnOf, uciToMove, type SimpleMove } from '../lib/chess';
import { moveSound, playSound } from '../lib/sound';
import { loadGame } from '../lib/storage';
import { bumpPlan, loadDrills, logEvents, saveDrill } from '../training/activity';
import { INTERVALS, daysUntil, dueDrills, scheduleDrill, type Drill } from '../training/drills';
import { eventsFromDrill } from '../training/skills';

/** How much win chance a different move may give up and still count as fixing the mistake. */
const TOLERANCE = 5;

function Session({ queue, onDone }: { queue: Drill[]; onDone: () => void }) {
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<{ correct: boolean; text: string; scheduled: Drill } | null>(null);
  const [busy, setBusy] = useState(false);
  const [fen, setFen] = useState(queue[0].fen);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [announce, setAnnounce] = useState('');
  const [error, setError] = useState<string | null>(null);
  const drill = queue[index];
  const game = useMemo(() => loadGame(drill.gameId), [drill]);

  async function onMove(move: SimpleMove) {
    if (result || busy) return;
    const probe = new Chess(drill.fen);
    const played = probe.move(move);
    playSound(moveSound(played.san));
    setFen(probe.fen());
    setLastMove({ from: move.from, to: move.to });
    setBusy(true);
    setError(null);
    try {
      let correct = moveToUci(move) === drill.bestUci;
      let text: string;
      if (correct) {
        text = `Yes, ${drill.bestSan} is the engine's choice.`;
      } else {
        const analysis = await analysisEngine.search(probe.fen(), { depth: 14 });
        const win = winPercentFor(scoreOf(analysis, turnOf(probe.fen())), drill.color);
        const loss = drill.winBefore - win;
        correct = loss < TOLERANCE;
        text = correct
          ? `${played.san} works too. The engine's top choice was ${drill.bestSan}.`
          : `${played.san} still gives up about ${Math.round(loss)}% of your win chances. The move was ${drill.bestSan}: ${drill.bestLine}.`;
      }
      const scheduled = scheduleDrill(drill, correct, Date.now());
      saveDrill(scheduled);
      logEvents(eventsFromDrill(drill.themes, correct, Date.now()));
      bumpPlan('drills');
      playSound(correct ? 'correct' : 'wrong');
      setAnnounce(text);
      setResult({ correct, text, scheduled });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setFen(drill.fen);
      setLastMove(null);
    } finally {
      setBusy(false);
    }
  }

  function next() {
    if (index + 1 >= queue.length) {
      onDone();
      return;
    }
    setIndex(index + 1);
    setResult(null);
    setFen(queue[index + 1].fen);
    setLastMove(null);
  }

  const arrows: Arrow[] = [];
  if (result && !result.correct) {
    const best = uciToMove(drill.bestUci);
    arrows.push({ from: best.from, to: best.to, tone: 'good' });
  }
  const shownFen = result && !result.correct ? drill.fen : fen;
  const movable = !result && !busy ? drill.color : null;

  return (
    <div className="game">
      <LiveRegion text={announce} />
      <div className="game-board">
        <Board fen={shownFen} orientation={drill.color} movable={movable} onMove={(move) => void onMove(move)} lastMove={result && !result.correct ? null : lastMove} arrows={arrows} label="Drill position" />
      </div>
      <aside className="panel">
        <div className="train-head">
          <span className="phase-tag">Drill {index + 1} of {queue.length}</span>
        </div>
        <h1 className="train-title">Find a better move</h1>
        <p>
          {game ? <>Against {game.white === 'You' || game.playerColor === 'w' ? game.black : game.white} you played </> : <>You played </>}
          <strong>{drill.playedSan}</strong> here, which was a mistake. What should you have played?
        </p>
        {busy && <p className="status" role="status">Checking your move…</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {result && (
          <div className={result.correct ? 'feedback feedback-good' : 'feedback feedback-bad'} role="status">
            <p>{result.text}</p>
            <p className="small">
              {result.scheduled.retired
                ? 'You have this one for good, so it is retired.'
                : `It comes back in ${daysUntil(result.scheduled, Date.now())} ${daysUntil(result.scheduled, Date.now()) === 1 ? 'day' : 'days'}.`}
            </p>
          </div>
        )}
        {result && (
          <button type="button" className="btn btn-primary" onClick={next}>{index + 1 >= queue.length ? 'Finish' : 'Next drill'}</button>
        )}
        {!result && <MoveInput fen={drill.fen} disabled={busy} onMove={(from, to, promotion) => void onMove({ from, to, promotion } as SimpleMove)} />}
        {!result && drill.headline && (
          <details className="small">
            <summary>What went wrong in the game?</summary>
            <p>{drill.headline}</p>
          </details>
        )}
      </aside>
    </div>
  );
}

export function DrillsPage() {
  const [running, setRunning] = useState(false);
  const [version, setVersion] = useState(0);
  const [queue, setQueue] = useState<Drill[]>([]);
  const drills = useMemo(() => loadDrills(), [version, running]); // eslint-disable-line react-hooks/exhaustive-deps
  const due = useMemo(() => dueDrills(drills, Date.now()), [drills]);
  useEffect(() => setRunning(false), []);

  if (running && queue.length) {
    return <Session queue={queue} onDone={() => { setRunning(false); setVersion((v) => v + 1); }} />;
  }

  const active = drills.filter((drill) => !drill.retired);
  const retired = drills.length - active.length;
  const nextDue = active.filter((drill) => drill.dueAt > Date.now()).sort((a, b) => a.dueAt - b.dueAt)[0];

  return (
    <div className="drills-home">
      <p className="muted">
        Mistakes from your reviewed games become drills. Get one right and it returns after {INTERVALS.slice(1, 4).join(', ')} and {INTERVALS[4]} days, until you have it for good. Miss it, and it comes back tomorrow.
      </p>
      <dl className="hero-stats drill-stats">
        <div><dt>Due now</dt><dd>{due.length}</dd></div>
        <div><dt>In rotation</dt><dd>{active.length}</dd></div>
        <div><dt>Mastered</dt><dd>{retired}</dd></div>
      </dl>
      {due.length > 0 ? (
        <button type="button" className="btn btn-primary btn-large" onClick={() => { setQueue(due.slice(0, 10)); setRunning(true); }}>
          <Repeat size={18} aria-hidden="true" />Start {Math.min(due.length, 10)} {due.length === 1 ? 'drill' : 'drills'}
        </button>
      ) : drills.length > 0 ? (
        <p className="all-done"><CheckCircle2 size={18} aria-hidden="true" /> All caught up.{nextDue ? ` Next drill in ${daysUntil(nextDue, Date.now())} ${daysUntil(nextDue, Date.now()) === 1 ? 'day' : 'days'}.` : ''}</p>
      ) : (
        <div>
          <p>No drills yet. Analyse a game you played, and your mistakes will appear here.</p>
          <a className="btn btn-primary" href="#/review">Go to Review</a>
        </div>
      )}
    </div>
  );
}
