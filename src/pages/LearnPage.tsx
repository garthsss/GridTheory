import { Chess } from 'chess.js';
import { useEffect, useMemo, useState } from 'react';
import { Board, type Arrow } from '../components/Board';
import { MoveList, Rich } from '../components/ui';
import { buildMoveReport } from '../coach/explain';
import { COURSE, lessonById, nextLesson } from '../course/content';
import type { GameStep, Lesson, PlayStep, ReadStep, Step } from '../course/types';
import { winPercentFor, scoreOf } from '../engine/score';
import { analysisEngine } from '../engine/uci';
import { START_FEN, fenFromMoves, moveToUci, stripSuffix, turnOf, type SimpleMove } from '../lib/chess';
import { moveSound, playSound } from '../lib/sound';
import { loadProgress, markLessonDone } from '../lib/storage';
import { bumpPlan } from '../training/activity';

/** How much win chance a move may give up and still count in engine-judged exercises. */
const ENGINE_TOLERANCE = 8;

function fenOf(step: ReadStep | PlayStep, previous: string): string {
  if (step.fen) return step.fen;
  if (step.kind === 'read' && step.moves) return fenFromMoves(step.moves);
  if (step.kind === 'play' && step.from) return fenFromMoves(step.from);
  return previous;
}

function ReadView({ step, fen, onNext }: { step: ReadStep; fen: string; onNext: () => void }) {
  const arrows: Arrow[] = (step.arrows ?? []).map(([from, to]) => ({ from, to }));
  return (
    <div className="lesson-grid">
      <Board fen={fen} orientation={turnOf(fen) === 'b' && step.fen ? 'b' : 'w'} arrows={arrows} marks={step.marks} />
      <div className="lesson-text">
        <Rich text={step.text} />
        <button type="button" className="btn btn-primary" onClick={onNext}>Continue</button>
      </div>
    </div>
  );
}

function PlayView({ step, fen, onNext }: { step: PlayStep; fen: string; onNext: () => void }) {
  const orientation = turnOf(fen);
  const [position, setPosition] = useState(fen);
  const [ply, setPly] = useState(0);
  const [feedback, setFeedback] = useState<{ tone: 'good' | 'bad' | 'info'; text: string } | null>(null);
  const [solved, setSolved] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [judging, setJudging] = useState(false);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [wrong, setWrong] = useState(0);
  const [revealed, setRevealed] = useState<string | null>(null);

  useEffect(() => {
    setPosition(fen);
    setPly(0);
    setFeedback(null);
    setSolved(false);
    setShowHint(false);
    setLastMove(null);
    setWrong(0);
    setRevealed(null);
  }, [fen, step]);

  function advance(chess: Chess, nextPly: number) {
    setRevealed(null);
    if (nextPly >= step.line.length) {
      playSound('correct');
      setSolved(true);
      setFeedback({ tone: 'good', text: step.done });
      setPosition(chess.fen());
      return;
    }
    setPosition(chess.fen());
    setPly(nextPly);
    setFeedback({ tone: 'good', text: 'Correct. Keep going.' });
    const reply = step.line[nextPly];
    window.setTimeout(() => {
      const move = chess.move(reply);
      playSound(moveSound(move.san));
      setLastMove({ from: move.from, to: move.to });
      setPosition(chess.fen());
      setPly(nextPly + 1);
      if (nextPly + 1 >= step.line.length) {
        setSolved(true);
        setFeedback({ tone: 'good', text: step.done });
      }
    }, 280);
  }

  async function judgeWithEngine(move: SimpleMove, san: string) {
    setJudging(true);
    try {
      const probe = new Chess(position);
      probe.move(move);
      const [before, after] = await Promise.all([
        analysisEngine.search(position, { depth: 14, multipv: 1 }),
        analysisEngine.search(probe.fen(), { depth: 14, multipv: 1 }),
      ]);
      const color = turnOf(position);
      const loss = winPercentFor(scoreOf(before, color), color) - winPercentFor(scoreOf(after, turnOf(probe.fen())), color);
      if (loss <= ENGINE_TOLERANCE) {
        setLastMove({ from: move.from, to: move.to });
        setPosition(probe.fen());
        setSolved(true);
        setFeedback({
          tone: 'info',
          text: `${san} holds up according to the engine, but the idea to practise here is **${step.line[0]}**. ${step.done}`,
        });
      } else {
        const report = buildMoveReport(position, moveToUci(move), before, after);
        setWrong((n) => n + 1);
        setFeedback({ tone: 'bad', text: `${report.headline} Try again.` });
      }
    } catch (error) {
      setFeedback({ tone: 'bad', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setJudging(false);
    }
  }

  function onMove(move: SimpleMove) {
    const chess = new Chess(position);
    const played = chess.move(move);
    const expected = step.line[ply];
    const matches = (san: string) => stripSuffix(san) === stripSuffix(played.san);

    if (matches(expected)) {
      playSound(moveSound(played.san));
      setLastMove({ from: move.from, to: move.to });
      advance(chess, ply + 1);
      return;
    }
    if (ply === 0 && step.also?.some(matches)) {
      playSound('correct');
      setLastMove({ from: move.from, to: move.to });
      setPosition(chess.fen());
      setSolved(true);
      setFeedback({ tone: 'good', text: `${played.san} works too. ${step.done}` });
      return;
    }
    if (step.judge === 'engine' && ply === 0) {
      void judgeWithEngine(move, played.san);
      return;
    }
    playSound('wrong');
    setWrong((n) => n + 1);
    setFeedback({ tone: 'bad', text: `${played.san} isn't it. Look again.` });
  }

  const hintArrow: Arrow[] = useMemo(() => {
    if (!revealed) return [];
    const chess = new Chess(position);
    try {
      const move = chess.move(revealed);
      return [{ from: move.from, to: move.to, tone: 'good' as const }];
    } catch {
      return [];
    }
  }, [revealed, position]);

  const waitingForReply = !solved && ply % 2 === 1;

  return (
    <div className="lesson-grid">
      <Board
        fen={position}
        orientation={orientation}
        movable={solved || judging || waitingForReply ? null : turnOf(position)}
        onMove={onMove}
        lastMove={lastMove}
        arrows={hintArrow}
      />
      <div className="lesson-text">
        <Rich text={step.text} />
        {feedback && <div className={`feedback feedback-${feedback.tone}`} role="status"><Rich text={feedback.text} /></div>}
        {judging && <p className="muted">Checking your move with the engine…</p>}
        {showHint && !solved && <p className="hint-text">{step.hint}</p>}
        <div className="btn-row">
          {solved ? (
            <button type="button" className="btn btn-primary" onClick={onNext}>Continue</button>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => setShowHint(true)} disabled={showHint}>Hint</button>
              {(wrong >= 2 || showHint) && (
                <button type="button" className="btn btn-quiet" onClick={() => setRevealed(step.line[ply])}>Show the move</button>
              )}
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setPosition(fen);
                  setPly(0);
                  setFeedback(null);
                  setLastMove(null);
                  setRevealed(null);
                }}
              >
                Reset
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function GameView({ step, onNext }: { step: GameStep; onNext: () => void }) {
  const sans = useMemo(() => step.moves.split(' '), [step.moves]);
  const [ply, setPly] = useState(0);
  const { fen, last } = useMemo(() => {
    const chess = new Chess();
    let lastMove: { from: string; to: string } | null = null;
    for (const san of sans.slice(0, ply)) {
      const move = chess.move(san);
      lastMove = { from: move.from, to: move.to };
    }
    return { fen: chess.fen(), last: lastMove };
  }, [sans, ply]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') setPly((p) => Math.min(p + 1, sans.length));
      if (event.key === 'ArrowLeft') setPly((p) => Math.max(p - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sans.length]);

  return (
    <div className="lesson-grid">
      <Board fen={fen} lastMove={last} />
      <div className="lesson-text">
        <p className="game-title"><strong>{step.white} vs {step.black}</strong><br /><span className="muted">{step.event}</span></p>
        {ply === 0 && <Rich text={step.text} />}
        {step.notes[ply] && <div className="feedback feedback-info"><Rich text={step.notes[ply]} /></div>}
        <MoveList sans={sans} current={ply} onSelect={setPly} />
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => setPly(Math.max(ply - 1, 0))} disabled={ply === 0}>Back</button>
          <button type="button" className="btn btn-primary" onClick={() => setPly(Math.min(ply + 1, sans.length))} disabled={ply === sans.length}>Next move</button>
          <button type="button" className="btn btn-quiet" onClick={onNext}>{ply === sans.length ? 'Continue' : 'Skip'}</button>
        </div>
      </div>
    </div>
  );
}

function LessonView({ lesson }: { lesson: Lesson }) {
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [lesson.id]);

  const fens = useMemo(() => {
    const out: string[] = [];
    let current = START_FEN;
    for (const step of lesson.steps) {
      if (step.kind !== 'game') current = fenOf(step, current);
      out.push(current);
    }
    return out;
  }, [lesson]);

  const finished = index >= lesson.steps.length;
  useEffect(() => {
    if (finished) {
      markLessonDone(lesson.id);
      bumpPlan('lesson');
    }
  }, [finished, lesson.id]);

  const step: Step | undefined = lesson.steps[index];
  const next = nextLesson(lesson.id);
  const goNext = () => setIndex((i) => i + 1);

  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb"><a href="#/learn">Course</a> / {lesson.title}</nav>
      <header className="lesson-head">
        <h1>{lesson.title}</h1>
        <div className="step-dots" role="progressbar" aria-label="Lesson progress" aria-valuenow={Math.min(index, lesson.steps.length)} aria-valuemin={0} aria-valuemax={lesson.steps.length}>
          {lesson.steps.map((_, i) => (
            <span key={i} className={i < index ? 'dot-done' : i === index ? 'dot-now' : ''} />
          ))}
        </div>
      </header>
      {finished ? (
        <div className="end-card">
          <h2>Lesson complete</h2>
          <div className="btn-row">
            {next && <a className="btn btn-primary" href={`#/learn/${next.id}`}>Next: {next.title}</a>}
            <a className="btn" href="#/learn">Back to the course</a>
            <button type="button" className="btn btn-quiet" onClick={() => setIndex(0)}>Repeat</button>
          </div>
        </div>
      ) : step.kind === 'read' ? (
        <ReadView key={index} step={step} fen={fens[index]} onNext={goNext} />
      ) : step.kind === 'play' ? (
        <PlayView key={index} step={step} fen={fens[index]} onNext={goNext} />
      ) : (
        <GameView key={index} step={step} onNext={goNext} />
      )}
    </div>
  );
}

export function LearnPage({ lessonId }: { lessonId?: string }) {
  const lesson = lessonId ? lessonById(lessonId) : null;
  if (lesson) return <LessonView lesson={lesson} />;
  const progress = loadProgress();
  const total = COURSE.reduce((sum, level) => sum + level.lessons.length, 0);
  const done = COURSE.flatMap((level) => level.lessons).filter((l) => progress[l.id]).length;
  return (
    <div className="page">
      <header className="page-head">
        <h1>The course</h1>
        <p className="muted">
          From your first pawn move to grandmaster ideas: {done} of {total} lessons done. The lessons are original, and follow
          the order the classic books teach in. The books are listed under each level if you want to go deeper.
        </p>
      </header>
      {COURSE.map((level, levelIndex) => {
        const finished = level.lessons.filter((item) => progress[item.id]).length;
        const current = COURSE.findIndex((candidate) => candidate.lessons.some((item) => !progress[item.id]));
        return (
          <details className="level" key={level.id} open={levelIndex === Math.max(current, 0)}>
            <summary className="level-head">
              <span className="level-num">{levelIndex + 1}</span>
              <span className="level-title">
                <strong>{level.title}</strong>
                <span className="muted small">{level.rating} · {finished}/{level.lessons.length} done</span>
              </span>
              <span className="level-bar" aria-hidden="true"><span style={{ width: `${(finished / level.lessons.length) * 100}%` }} /></span>
            </summary>
            <p className="muted level-intro">{level.intro}</p>
            <ol className="lessons">
              {level.lessons.map((item) => (
                <li key={item.id}>
                  <a href={`#/learn/${item.id}`} className={progress[item.id] ? 'lesson-link lesson-done' : 'lesson-link'}>
                    <span className="lesson-title">{item.title}</span>
                    <span className="lesson-summary">{item.summary}</span>
                    {progress[item.id] && <span className="lesson-check" aria-label="Completed">Done</span>}
                  </a>
                </li>
              ))}
            </ol>
            <p className="reading"><strong>Further reading:</strong> {level.reading.join('; ')}.</p>
          </details>
        );
      })}
    </div>
  );
}
