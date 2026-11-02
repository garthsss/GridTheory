import { Chess } from 'chess.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Board, type Arrow } from '../components/Board';
import { ClassBadge, MoveList, PgnActions } from '../components/ui';
import { lessonById } from '../course/content';
import { analysisEngine } from '../engine/uci';
import { formatScore, winPercent, winPercentFor, scoreOf, type MoveClass, type Score } from '../engine/score';
import { openingFromFens } from '../lib/openings';
import { PGN_LIMITS, PgnError, moveToUci, parseGame, splitGames, turnOf, uciToMove, type ParsedGame, type SimpleMove } from '../lib/chess';
import { deleteGame, loadGame, loadGames, loadProfile, newId, saveGame, type SavedGame } from '../lib/storage';
import { ingestReview, setPlayerColor } from '../training/activity';
import { ImportPanel } from '../components/ImportPanel';
import { analyzeGame, recommendations, type ReviewData, type ReviewedMove } from '../review/analyze';

const SAMPLE = `[White "Paul Morphy"]
[Black "Duke of Brunswick and Count Isouard"]
[Event "Paris 1858"]
[Result "1-0"]

1.e4 e5 2.Nf3 d6 3.d4 Bg4 4.dxe5 Bxf3 5.Qxf3 dxe5 6.Bc4 Nf6 7.Qb3 Qe7 8.Nc3 c6 9.Bg5 b5 10.Nxb5 cxb5 11.Bxb5+ Nbd7 12.O-O-O Rd8 13.Rxd7 Rxd7 14.Rd1 Qe6 15.Bxd7+ Nxd7 16.Qb8+ Nxb8 17.Rd8# 1-0`;

const DEPTHS = [
  { depth: 10, label: 'Quick', note: 'A few seconds' },
  { depth: 14, label: 'Standard', note: 'Seconds to a minute' },
  { depth: 18, label: 'Deep', note: 'A minute or more' },
];

function Submit({ onOpen }: { onOpen: (game: SavedGame) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [games, setGames] = useState<SavedGame[]>(() => loadGames());
  const [visible, setVisible] = useState(50);

  function submit(input: string) {
    setError(null);
    try {
      const parts = splitGames(input);
      if (parts.length === 0) {
        setError('Paste a game first.');
        return;
      }
      let first: SavedGame | null = null;
      const profile = loadProfile();
      const mine = [profile.name, profile.lichess, profile.chesscom].flatMap((name) => (name ? [name.toLowerCase()] : []));
      // Oldest first, so the first game in the file ends up on top of the library.
      for (const part of [...parts].reverse()) {
        const parsed = parseGame(part);
        const white = parsed.headers.White ?? 'White';
        const black = parsed.headers.Black ?? 'Black';
        const game: SavedGame = {
          id: newId(),
          date: new Date().toISOString(),
          pgn: part,
          white,
          black,
          result: parsed.result,
          source: 'import',
          playerColor: mine.includes(white.toLowerCase()) ? 'w' : mine.includes(black.toLowerCase()) ? 'b' : null,
        };
        saveGame(game);
        first = game;
      }
      if (first) onOpen(first);
    } catch (err) {
      setError(err instanceof PgnError ? err.message : String(err));
    }
  }

  async function onFile(file: File) {
    if (file.size > PGN_LIMITS.input) {
      setError('That file is too large. The limit is 5 MB at a time.');
      return;
    }
    const content = await file.text();
    setText(content);
    submit(content);
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Review a game</h1>
        <p className="muted">
          Paste a game in chess notation, from a tournament scoresheet, Chess.com, Lichess or anywhere else. Stockfish grades
          every move, explains the turning points, and suggests what to study next.
        </p>
      </header>
      <ImportPanel onChange={() => setGames(loadGames())} />
      <div className="submit-box">
        <label htmlFor="pgn">Game notation (PGN, or moves like 1.e4 e5 2.Nf3 Nc6)</label>
        <textarea
          id="pgn"
          rows={9}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 …"
          spellCheck={false}
        />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={() => submit(text)}>Analyse game</button>
          <label className="btn">
            Upload .pgn
            <input
              type="file"
              accept=".pgn,.txt"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onFile(file);
              }}
            />
          </label>
          <button type="button" className="btn btn-quiet" onClick={() => setText(SAMPLE)}>Use a sample game</button>
        </div>
      </div>

      {games.length > 0 && (
        <section>
          <h2>Your games</h2>
          <ul className="library">
            {games.slice(0, visible).map((game) => (
              <li key={game.id}>
                <a href={`#/review/${game.id}`}>
                  <strong>{game.white} vs {game.black}</strong>
                  <span className="muted"> {game.result} · {new Date(game.date).toLocaleDateString()}{game.review ? ` · ${Math.round(game.playerColor ? game.review.sides[game.playerColor].accuracy : (game.review.sides.w.accuracy + game.review.sides.b.accuracy) / 2)}% accuracy` : ''}</span>
                </a>
                <button
                  type="button"
                  className="btn btn-quiet"
                  aria-label={`Delete ${game.white} vs ${game.black}`}
                  onClick={() => {
                    deleteGame(game.id);
                    setGames(loadGames());
                  }}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
          {games.length > visible && (
            <button type="button" className="btn btn-quiet" onClick={() => setVisible(visible + 50)}>Show more ({games.length - visible} left)</button>
          )}
        </section>
      )}
    </div>
  );
}

function EvalGraph({ moves, ply, onSelect }: { moves: ReviewedMove[]; ply: number; onSelect: (ply: number) => void }) {
  if (moves.length === 0) return null;
  const width = 600;
  const height = 110;
  const x = (i: number) => (i / moves.length) * width;
  const y = (win: number) => height - (win / 100) * height;
  const points = [`0,${y(50)}`, ...moves.map((move, i) => `${x(i + 1)},${y(winPercent(move.scoreAfter as Score))}`)];
  const area = `0,${height} ${points.join(' ')} ${width},${height}`;
  return (
    <svg
      className="evalgraph"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="White's win chance over the game"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onSelect(Math.round(((event.clientX - rect.left) / rect.width) * moves.length));
      }}
    >
      <polygon points={area} className="graph-area" />
      <line x1="0" x2={width} y1={height / 2} y2={height / 2} className="graph-mid" />
      <polyline points={points.join(' ')} className="graph-line" vectorEffect="non-scaling-stroke" />
      {moves.map((move, i) =>
        move.cls === 'blunder' || move.cls === 'mistake' || move.cls === 'brilliant' ? (
          <circle
            key={i}
            cx={x(i + 1)}
            cy={y(winPercent(move.scoreAfter as Score))}
            r="3.5"
            className={`graph-dot graph-${move.cls}`}
            vectorEffect="non-scaling-stroke"
          />
        ) : null,
      )}
      <line x1={x(ply)} x2={x(ply)} y1="0" y2={height} className="graph-cursor" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Summary({ review, color }: { review: ReviewData; color: 'w' | 'b' }) {
  const side = review.sides[color];
  const rows: MoveClass[] = ['brilliant', 'best', 'good', 'inaccuracy', 'mistake', 'blunder'];
  return (
    <div className="side-summary">
      <div className="accuracy"><span>{Math.round(side.accuracy)}%</span> accuracy</div>
      <ul>
        {rows.map((cls) => (
          <li key={cls}><ClassBadge cls={cls} /> <strong>{side.counts[cls] ?? 0}</strong></li>
        ))}
      </ul>
      <p className="small muted">
        {(['opening', 'middlegame', 'endgame'] as const)
          .filter((phase) => side.phases[phase])
          .map((phase) => `${phase[0].toUpperCase()}${phase.slice(1)} ${Math.round(side.phases[phase]!.accuracy)}%`)
          .join(' · ')}
      </p>
    </div>
  );
}

function RetryCard({ move, onDone }: { move: ReviewedMove; onDone: () => void }) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [solved, setSolved] = useState(false);

  async function onMove(simple: SimpleMove) {
    const uci = moveToUci(simple);
    if (uci === move.bestUci) {
      setSolved(true);
      setFeedback(`Yes, ${move.bestSan} is the engine's choice.`);
      return;
    }
    setBusy(true);
    const chess = new Chess(move.fenBefore);
    const san = chess.move(simple).san;
    const analysis = await analysisEngine.search(chess.fen(), { depth: 12 });
    const win = winPercentFor(scoreOf(analysis, turnOf(chess.fen())), move.color);
    const loss = move.winBefore - win;
    setBusy(false);
    if (loss < 5) {
      setSolved(true);
      setFeedback(`${san} is close to the best here, and much better than ${move.san}. The engine's top choice was ${move.bestSan}.`);
    } else {
      setFeedback(`${san} still gives up about ${Math.round(loss)}% of your win chances. Try again.`);
    }
  }

  return (
    <div className="retry">
      <p className="small"><strong>Find a better move than {move.san}.</strong></p>
      <Board fen={move.fenBefore} orientation={move.color} movable={solved || busy ? null : move.color} onMove={(m) => void onMove(m)} />
      {feedback && <p className={solved ? 'feedback feedback-good' : 'feedback feedback-bad'} role="status">{feedback}</p>}
      <button type="button" className="btn" onClick={onDone}>{solved ? 'Back to the review' : 'Stop trying'}</button>
    </div>
  );
}

function GameReview({ game: initial }: { game: SavedGame }) {
  const [game, setGame] = useState(initial);
  const parsed: ParsedGame | null = useMemo(() => {
    try {
      return parseGame(game.pgn);
    } catch {
      return null;
    }
  }, [game.pgn]);
  const [depth, setDepth] = useState(14);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ply, setPly] = useState(0);
  const [color, setColor] = useState<'w' | 'b'>(game.playerColor ?? 'w');
  const [retry, setRetry] = useState<ReviewedMove | null>(null);
  const cancelled = useRef(false);
  const running = useRef(false);
  const review = game.review;

  useEffect(() => {
    return () => {
      // Only stops this page's own run: a background batch shares the same engine.
      if (running.current) {
        cancelled.current = true;
        analysisEngine.cancelAll();
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!parsed || event.target instanceof HTMLInputElement) return;
      if (event.key === 'ArrowRight') setPly((p) => Math.min(p + 1, parsed.moves.length));
      if (event.key === 'ArrowLeft') setPly((p) => Math.max(p - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [parsed]);

  if (!parsed) return <div className="page"><p className="error">This saved game could not be read.</p></div>;

  async function run() {
    setError(null);
    setProgress(0);
    cancelled.current = false;
    running.current = true;
    try {
      const data = await analyzeGame(parsed!, depth, setProgress, () => cancelled.current);
      if (data) {
        const next = { ...game, review: data };
        saveGame(next);
        setGame(ingestReview(next));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      running.current = false;
      setProgress(null);
    }
  }

  const sans = parsed.moves.map((m) => m.san);
  const opening = openingFromFens(parsed.moves.map((m) => m.fenAfter));
  const fen = ply === 0 ? parsed.startFen : parsed.moves[ply - 1].fenAfter;
  const lastMove = ply === 0 ? null : uciToMove(parsed.moves[ply - 1].uci);
  const current: ReviewedMove | undefined = review?.moves[ply - 1];
  const arrows: Arrow[] = [];
  if (current && (current.cls === 'mistake' || current.cls === 'blunder' || current.cls === 'inaccuracy') && current.bestUci) {
    const best = uciToMove(current.bestUci);
    arrows.push({ from: best.from, to: best.to, tone: 'good' });
  }
  const shownFen = current && arrows.length ? current.fenBefore : fen;
  const keyMoments = review?.moves.filter((m) => m.color === color && (m.cls === 'mistake' || m.cls === 'blunder' || m.cls === 'brilliant')) ?? [];
  const recs = review ? recommendations(review, color) : [];

  return (
    <div className="page">
      <nav className="crumbs"><a href="#/review">Review</a> / {game.white} vs {game.black}</nav>
      <header className="page-head">
        <h1>{game.white} vs {game.black} <span className="muted result">{parsed.result}</span></h1>
        {opening && <p className="muted">{opening}</p>}
      </header>

      {retry ? (
        <RetryCard move={retry} onDone={() => setRetry(null)} />
      ) : (
        <div className="review-grid">
          <div>
            <Board fen={shownFen} orientation={color} lastMove={arrows.length ? null : lastMove} arrows={arrows} />
            {review && <EvalGraph moves={review.moves} ply={ply} onSelect={setPly} />}
            <div className="btn-row center">
              <button type="button" className="btn" onClick={() => setPly(0)} aria-label="First move">«</button>
              <button type="button" className="btn" onClick={() => setPly(Math.max(ply - 1, 0))} aria-label="Previous move">‹</button>
              <button type="button" className="btn" onClick={() => setPly(Math.min(ply + 1, sans.length))} aria-label="Next move">›</button>
              <button type="button" className="btn" onClick={() => setPly(sans.length)} aria-label="Last move">»</button>
            </div>
          </div>
          <aside className="panel">
            {!review && (
              <div className="analyse-box">
                <h2>Analyse this game</h2>
                <div className="segmented">
                  {DEPTHS.map((option) => (
                    <button key={option.depth} type="button" aria-pressed={depth === option.depth} onClick={() => setDepth(option.depth)} disabled={progress !== null}>
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className="small muted">{DEPTHS.find((d) => d.depth === depth)?.note}, depending on your computer and the game's length.</p>
                {progress !== null ? (
                  <>
                    <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                      <div style={{ width: `${progress * 100}%` }} />
                    </div>
                    <button type="button" className="btn btn-quiet" onClick={() => { cancelled.current = true; analysisEngine.cancelAll(); }}>Cancel</button>
                  </>
                ) : (
                  <button type="button" className="btn btn-primary" onClick={() => void run()}>Run analysis</button>
                )}
                {error && <p className="error">{error}</p>}
              </div>
            )}

            {review && (
              <>
                <div className="segmented" role="group" aria-label="Whose moves to focus on">
                  <button type="button" aria-pressed={color === 'w'} onClick={() => setColor('w')}>{game.white}</button>
                  <button type="button" aria-pressed={color === 'b'} onClick={() => setColor('b')}>{game.black}</button>
                </div>
                <Summary review={review} color={color} />
                {!game.playerColor && (
                  <div className="whose-game">
                    <p className="small"><strong>Was this your game?</strong> Tell me which side you had, and your mistakes will become drills.</p>
                    <div className="btn-row">
                      {(['w', 'b'] as const).map((side) => (
                        <button
                          key={side}
                          type="button"
                          className="btn"
                          onClick={() => {
                            const updated = setPlayerColor(game.id, side);
                            if (updated) setGame(updated);
                            setColor(side);
                          }}
                        >
                          I played {side === 'w' ? 'White' : 'Black'}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {current && (
                  <div className={`move-note move-note-${current.cls}`}>
                    <p><ClassBadge cls={current.cls} /> <strong>{current.san}</strong> <span className="muted">{formatScore(current.scoreAfter as Score)}</span></p>
                    {current.headline && <p><strong>{current.headline}</strong></p>}
                    {current.detail && <p className="small">{current.detail}</p>}
                    {(current.cls === 'mistake' || current.cls === 'blunder') && (
                      <button type="button" className="btn" onClick={() => setRetry(current)}>Try to find a better move</button>
                    )}
                  </div>
                )}
              </>
            )}

            <div className="moves-card">
              <MoveList
                sans={sans}
                current={ply}
                onSelect={setPly}
                classes={review?.moves.map((m) => (m.cls === 'best' || m.cls === 'good' ? undefined : m.cls))}
                startNumber={Number(parsed.startFen.split(' ')[5])}
                blackFirst={turnOf(parsed.startFen) === 'b'}
              />
            </div>
            <PgnActions pgn={game.pgn} />
          </aside>
        </div>
      )}

      {review && !retry && (
        <div className="review-lower">
          <section>
            <h2>Key moments</h2>
            {keyMoments.length === 0 ? (
              <p className="muted">No mistakes or blunders for this side. A clean game.</p>
            ) : (
              <ul className="moments">
                {keyMoments.map((moment) => (
                  <li key={moment.ply}>
                    <button type="button" onClick={() => { setPly(moment.ply); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                      <span className="moment-move">{moment.fenBefore.split(' ')[5]}{moment.color === 'w' ? '.' : '...'}{moment.san}</span>
                      <ClassBadge cls={moment.cls} />
                      <span className="moment-text">{moment.headline}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h2>What to work on</h2>
            {recs.length === 0 ? (
              <p className="muted">Nothing stands out from this game. Try a stronger opponent.</p>
            ) : (
              <ul className="recs">
                {recs.map((rec) => (
                  <li key={rec.title}>
                    <strong>{rec.title}</strong>
                    <p className="small">{rec.why}</p>
                    <p className="small">
                      Study: {rec.lessons.map((id, i) => (
                        <span key={id}>{i > 0 && ', '}<a href={`#/learn/${id}`}>{lessonById(id)?.title ?? id}</a></span>
                      ))}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export function ReviewPage({ gameId }: { gameId?: string }) {
  const game = gameId ? loadGame(gameId) : null;
  if (gameId && !game) {
    return <div className="page"><p className="error">That game is no longer saved.</p><a className="btn" href="#/review">Back to Review</a></div>;
  }
  if (game) return <GameReview key={game.id} game={game} />;
  return <Submit onOpen={(g) => { window.location.hash = `#/review/${g.id}`; }} />;
}
