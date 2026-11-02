import { Chess, type PieceSymbol, type Square } from 'chess.js';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { defaultPieces } from 'react-chessboard';
import { COLOR_NAMES, PIECE_NAMES, type SimpleMove } from '../lib/chess';
import { usePrefs } from '../lib/prefs';

export interface Arrow {
  from: string;
  to: string;
  tone?: 'good' | 'bad' | 'info' | 'user';
}

interface BoardProps {
  fen: string;
  orientation?: 'w' | 'b';
  /** Which side the player may move. Null makes the board read-only. */
  movable?: 'w' | 'b' | 'both' | null;
  onMove?: (move: SimpleMove) => void;
  arrows?: Arrow[];
  marks?: string[];
  lastMove?: { from: string; to: string } | null;
  /** Square to flash, used for hints. */
  highlight?: string | null;
  label?: string;
}

const FILES = 'abcdefgh';
const squareAt = (col: number, row: number, flipped: boolean) =>
  `${FILES[flipped ? 7 - col : col]}${flipped ? row + 1 : 8 - row}` as Square;
const toGrid = (square: string, flipped: boolean) => {
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]);
  return { col: flipped ? 7 - file : file, row: flipped ? rank - 1 : 8 - rank };
};

function PieceArt({ color, type }: { color: 'w' | 'b'; type: PieceSymbol }) {
  const render = defaultPieces[`${color}${type.toUpperCase()}`];
  return render ? render() : null;
}

interface PlacedPiece {
  id: number;
  color: 'w' | 'b';
  type: PieceSymbol;
  square: Square;
}

let nextPieceId = 1;

/**
 * Gives pieces stable identities across positions, so that the browser can slide each one to its new square.
 * Exact matches keep their id, then each remaining new piece takes the nearest unmatched old piece of the same
 * kind. Castling, captures, en passant, takebacks and jumps through a game all animate correctly this way.
 */
export function matchPieces(previous: PlacedPiece[], fen: string): PlacedPiece[] {
  const current = new Chess(fen, { skipValidation: true })
    .board()
    .flat()
    .filter((piece): piece is NonNullable<typeof piece> => piece !== null);
  const unused = new Set(previous);
  const placed: (PlacedPiece | null)[] = current.map((piece) => {
    const same = [...unused].find((old) => old.square === piece.square && old.type === piece.type && old.color === piece.color);
    if (!same) return null;
    unused.delete(same);
    return same;
  });
  return current.map((piece, index) => {
    if (placed[index]) return placed[index]!;
    let best: PlacedPiece | null = null;
    let distance = Infinity;
    for (const old of unused) {
      if (old.type !== piece.type || old.color !== piece.color) continue;
      const d = Math.abs(FILES.indexOf(old.square[0]) - FILES.indexOf(piece.square[0])) + Math.abs(Number(old.square[1]) - Number(piece.square[1]));
      if (d < distance) {
        distance = d;
        best = old;
      }
    }
    if (best) {
      unused.delete(best);
      return { ...best, square: piece.square };
    }
    return { id: nextPieceId++, color: piece.color, type: piece.type, square: piece.square };
  });
}

export function Board({ fen, orientation = 'w', movable = null, onMove, arrows = [], marks = [], lastMove, highlight, label = 'Chess board' }: BoardProps) {
  const prefs = usePrefs();
  const chess = useMemo(() => new Chess(fen), [fen]);
  const flipped = orientation === 'b';
  const rootRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [drag, setDrag] = useState<{ from: Square; x: number; y: number } | null>(null);
  const [promotion, setPromotion] = useState<{ from: Square; to: Square } | null>(null);
  const [cursor, setCursor] = useState<Square>(flipped ? 'e8' : 'e1');
  const [skipAnimation, setSkipAnimation] = useState(false);
  const [userMarks, setUserMarks] = useState<string[]>([]);
  const [userArrows, setUserArrows] = useState<Arrow[]>([]);
  const rightFrom = useRef<Square | null>(null);
  const piecesRef = useRef<PlacedPiece[]>([]);

  const pieces = useMemo(() => {
    piecesRef.current = matchPieces(piecesRef.current, fen);
    return piecesRef.current;
  }, [fen]);

  useEffect(() => {
    setSelected(null);
    setDrag(null);
    setPromotion(null);
    setUserMarks([]);
    setUserArrows([]);
  }, [fen]);

  // A dropped piece is already where it should be, so it should appear there without sliding again.
  useLayoutEffect(() => {
    if (!skipAnimation) return;
    const frame = requestAnimationFrame(() => setSkipAnimation(false));
    return () => cancelAnimationFrame(frame);
  }, [skipAnimation, fen]);

  const canMoveNow = movable === 'both' || movable === chess.turn();
  const moves = useMemo(
    () => (canMoveNow && selected ? chess.moves({ square: selected, verbose: true }) : []),
    [canMoveNow, chess, selected],
  );
  const targets = new Set<string>(moves.map((move) => move.to));
  const captures = new Set<string>(moves.filter((move) => move.captured).map((move) => move.to));

  const kingInCheck = useMemo(() => {
    if (!chess.inCheck()) return null;
    return chess.board().flat().find((piece) => piece?.type === 'k' && piece.color === chess.turn())?.square ?? null;
  }, [chess]);

  function attempt(from: Square, to: Square) {
    const legal = chess.moves({ square: from, verbose: true }).filter((move) => move.to === to);
    if (legal.length === 0) return false;
    if (legal.some((move) => move.promotion)) {
      if (prefs.autoQueen) onMove?.({ from, to, promotion: 'q' });
      else setPromotion({ from, to });
      return true;
    }
    onMove?.({ from, to });
    return true;
  }

  const fromPointer = (event: { clientX: number; clientY: number }) => {
    const rect = rootRef.current!.getBoundingClientRect();
    const col = Math.floor(((event.clientX - rect.left) / rect.width) * 8);
    const row = Math.floor(((event.clientY - rect.top) / rect.height) * 8);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return squareAt(col, row, flipped);
  };

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const square = fromPointer(event);
    if (!square) return;
    if (event.button === 2) {
      rightFrom.current = square;
      return;
    }
    if (event.button !== 0 || promotion) return;
    setUserMarks([]);
    setUserArrows([]);
    if (!canMoveNow) return;
    setCursor(square);
    if (selected && selected !== square && targets.has(square)) {
      setSkipAnimation(false);
      attempt(selected, square);
      setSelected(null);
      return;
    }
    const piece = chess.get(square);
    if (piece && piece.color === chess.turn()) {
      setSelected(square);
      setDrag({ from: square, x: event.clientX, y: event.clientY });
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } else {
      setSelected(null);
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag) setDrag({ ...drag, x: event.clientX, y: event.clientY });
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button === 2 && rightFrom.current) {
      const end = fromPointer(event);
      const start = rightFrom.current;
      rightFrom.current = null;
      if (!end) return;
      if (end === start) {
        setUserMarks((current) => (current.includes(end) ? current.filter((sq) => sq !== end) : [...current, end]));
      } else {
        setUserArrows((current) =>
          current.some((arrow) => arrow.from === start && arrow.to === end)
            ? current.filter((arrow) => !(arrow.from === start && arrow.to === end))
            : [...current, { from: start, to: end, tone: 'user' }],
        );
      }
      return;
    }
    if (!drag) return;
    const square = fromPointer(event);
    const from = drag.from;
    setDrag(null);
    if (square && square !== from) {
      setSkipAnimation(true);
      if (attempt(from, square)) setSelected(null);
      else setSkipAnimation(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (promotion) return;
    const deltas: Record<string, [number, number]> = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
    };
    const delta = deltas[event.key];
    if (delta) {
      event.preventDefault();
      event.stopPropagation();
      // Uses the latest cursor, so that fast key repeats aren't lost.
      setCursor((current) => {
        const { col, row } = toGrid(current, flipped);
        return squareAt(Math.min(7, Math.max(0, col + delta[0])), Math.min(7, Math.max(0, row + delta[1])), flipped);
      });
      return;
    }
    if (event.key === 'Escape') {
      setSelected(null);
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (!canMoveNow) return;
    if (selected && targets.has(cursor)) {
      attempt(selected, cursor);
      setSelected(null);
      return;
    }
    const piece = chess.get(cursor);
    setSelected(piece && piece.color === chess.turn() && selected !== cursor ? cursor : null);
  }

  const describe = (square: Square) => {
    const piece = chess.get(square);
    const contents = piece ? `${COLOR_NAMES[piece.color]} ${PIECE_NAMES[piece.type]}` : 'empty';
    const notes: string[] = [];
    if (selected === square) notes.push('selected');
    if (targets.has(square)) notes.push(captures.has(square) ? 'can capture here' : 'can move here');
    return `${square}, ${contents}${notes.length ? `, ${notes.join(', ')}` : ''}`;
  };

  const squares = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const square = squareAt(col, row, flipped);
      const dark = (FILES.indexOf(square[0]) + Number(square[1])) % 2 === 1;
      const classes = ['sq', dark ? 'sq-dark' : 'sq-light'];
      if (lastMove && (lastMove.from === square || lastMove.to === square)) classes.push('sq-last');
      if (selected === square) classes.push('sq-selected');
      if (kingInCheck === square) classes.push('sq-check');
      if (highlight === square) classes.push('sq-hint');
      if (marks.includes(square)) classes.push('sq-mark');
      if (userMarks.includes(square)) classes.push('sq-user');
      if (cursor === square) classes.push('sq-cursor');
      squares.push(
        <div key={square} id={`sq-${square}`} className={classes.join(' ')} data-square={square} role="gridcell" aria-label={describe(square)}>
          {prefs.coordinates && row === 7 && <span className="coord coord-file">{square[0]}</span>}
          {prefs.coordinates && col === 0 && <span className="coord coord-rank">{square[1]}</span>}
          {prefs.legalDots && targets.has(square) && <span className={captures.has(square) ? 'dot dot-capture' : 'dot'} />}
        </div>,
      );
    }
  }

  const rect = rootRef.current?.getBoundingClientRect();
  const size = rect?.width ?? 480;
  const dragged = drag ? chess.get(drag.from) : null;
  const allArrows = [...arrows, ...userArrows];

  return (
    <div
      ref={rootRef}
      className={`board ${canMoveNow ? 'board-live' : ''}`}
      role="grid"
      aria-label={label}
      aria-activedescendant={`sq-${cursor}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      <div className="sq-layer">{squares}</div>
      <div className={`piece-layer ${skipAnimation ? 'no-anim' : ''}`} aria-hidden="true">
        {pieces.map((piece) => {
          const { col, row } = toGrid(piece.square, flipped);
          return (
            <div
              key={piece.id}
              className={`piece ${drag?.from === piece.square ? 'piece-lifted' : ''}`}
              style={{ transform: `translate(${col * 100}%, ${row * 100}%)` }}
            >
              <PieceArt color={piece.color} type={piece.type} />
            </div>
          );
        })}
      </div>
      <svg className="arrows" viewBox="0 0 8 8" aria-hidden="true">
        <defs>
          {(['good', 'bad', 'info', 'user'] as const).map((tone) => (
            <marker key={tone} id={`head-${tone}`} markerWidth="3" markerHeight="3" refX="1.6" refY="1.5" orient="auto">
              <path d="M0,0 L3,1.5 L0,3 z" className={`arrow-head head-${tone}`} />
            </marker>
          ))}
        </defs>
        {allArrows.map((arrow) => {
          const a = toGrid(arrow.from, flipped);
          const b = toGrid(arrow.to, flipped);
          const length = Math.hypot(b.col - a.col, b.row - a.row) || 1;
          const tone = arrow.tone ?? 'info';
          return (
            <line
              key={`${arrow.from}${arrow.to}${tone}`}
              x1={a.col + 0.5}
              y1={a.row + 0.5}
              x2={b.col + 0.5 - ((b.col - a.col) / length) * 0.4}
              y2={b.row + 0.5 - ((b.row - a.row) / length) * 0.4}
              className={`arrow-line line-${tone}`}
              markerEnd={`url(#head-${tone})`}
            />
          );
        })}
      </svg>
      {drag && dragged && (
        <div
          className="piece-drag"
          style={{ width: size / 8, height: size / 8, left: drag.x - size / 16, top: drag.y - size / 16 }}
        >
          <PieceArt color={dragged.color} type={dragged.type} />
        </div>
      )}
      {promotion && (
        <div className="promo" role="dialog" aria-label="Choose a piece to promote to" onKeyDown={(event) => { if (event.key === 'Escape') setPromotion(null); }}>
          <div className="promo-card">
            {(['q', 'r', 'b', 'n'] as const).map((type, index) => (
              <button
                key={type}
                type="button"
                aria-label={`Promote to ${PIECE_NAMES[type]}`}
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus={index === 0}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  onMove?.({ ...promotion, promotion: type });
                  setPromotion(null);
                }}
              >
                <PieceArt color={chess.turn()} type={type} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
