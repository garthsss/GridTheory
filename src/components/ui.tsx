import { Chess } from 'chess.js';
import { Check, ClipboardCopy, Download } from 'lucide-react';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { MoveClass } from '../engine/score';
import { formatClock } from '../lib/clock';

/** Renders the course's light markup: **bold** and *italic*, with blank lines as paragraphs. */
export function Rich({ text }: { text: string }) {
  const render = (line: string): ReactNode[] =>
    line.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part, i) => {
      if (part.startsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
      if (part.startsWith('*') && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
      return <Fragment key={i}>{part}</Fragment>;
    });
  return (
    <>
      {text.split(/\n{2,}/).map((para, i) => (
        <p key={i}>{render(para)}</p>
      ))}
    </>
  );
}

export const CLASS_LABELS: Record<MoveClass, string> = {
  brilliant: 'Brilliant',
  best: 'Best',
  good: 'Good',
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  blunder: 'Blunder',
};

export const CLASS_MARKS: Record<MoveClass, string> = {
  brilliant: '!!',
  best: '',
  good: '',
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
};

export function ClassBadge({ cls }: { cls: MoveClass }) {
  return <span className={`badge badge-${cls}`}>{CLASS_LABELS[cls]}</span>;
}

/** A vertical bar showing White's share of the win chances. */
export function EvalBar({ win, flipped }: { win: number; flipped: boolean }) {
  return (
    <div className={`evalbar ${flipped ? 'evalbar-flipped' : ''}`} role="img" aria-label={`White win chance ${Math.round(win)} percent`}>
      <div className="evalbar-white" style={{ height: `${win}%` }} />
    </div>
  );
}

export function ClockFace({ ms, active, label }: { ms: number; active: boolean; label: string }) {
  const low = ms < 20_000;
  return (
    <div className={`clock ${active ? 'clock-active' : ''} ${low ? 'clock-low' : ''}`} role="timer" aria-label={`${label} clock`}>
      {formatClock(ms)}
    </div>
  );
}

export function PlayerBar({ name, detail, initials, children, thinking }: { name: string; detail?: string; initials: string; children?: ReactNode; thinking?: boolean }) {
  return (
    <div className="player-bar">
      <span className="avatar" aria-hidden="true">{initials}</span>
      <span className="player-name">
        <strong>{name}</strong>
        {detail && <span className="muted"> {detail}</span>}
        {thinking && <span className="pulse" aria-hidden="true" />}
      </span>
      {children}
    </div>
  );
}

/** Captured pieces and material difference, worked out from the current position. */
export function MaterialDiff({ fen, color }: { fen: string; color: 'w' | 'b' }) {
  const counts = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const remaining = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const piece of new Chess(fen, { skipValidation: true }).board().flat()) {
    if (piece && piece.type !== 'k') remaining[piece.color][piece.type]++;
  }
  const worth = { p: 1, n: 3, b: 3, r: 5, q: 9 } as const;
  const glyphs = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' } as const;
  const enemy = color === 'w' ? 'b' : 'w';
  let captured = '';
  let mine = 0;
  let theirs = 0;
  for (const type of ['q', 'r', 'b', 'n', 'p'] as const) {
    captured += glyphs[type].repeat(Math.max(0, counts[type] - remaining[enemy][type]));
    mine += remaining[color][type] * worth[type];
    theirs += remaining[enemy][type] * worth[type];
  }
  const lead = mine - theirs;
  return (
    <span className="captured" aria-label={lead > 0 ? `Ahead by ${lead} points of material` : undefined}>
      <span aria-hidden="true">{captured}</span>
      {lead > 0 && <span className="lead"> +{lead}</span>}
    </span>
  );
}

export function MoveList({
  sans,
  current,
  onSelect,
  classes,
  startNumber = 1,
  blackFirst = false,
}: {
  sans: string[];
  current?: number;
  onSelect?: (ply: number) => void;
  classes?: (MoveClass | undefined)[];
  startNumber?: number;
  blackFirst?: boolean;
}) {
  const end = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const list = end.current;
    if (!list) return;
    if (currentRef.current) {
      const top = currentRef.current.offsetTop - list.offsetTop;
      if (top < list.scrollTop || top > list.scrollTop + list.clientHeight - 32) list.scrollTop = top - 60;
    } else if (current === undefined) {
      list.scrollTop = list.scrollHeight;
    }
  }, [sans.length, current]);

  const cells = blackFirst ? [null, ...sans] : sans;
  const rows = [];
  for (let i = 0; i < cells.length; i += 2) {
    const cell = (index: number) => {
      const san = cells[index];
      if (san === null || san === undefined) return <span />;
      const ply = blackFirst ? index : index + 1;
      const cls = classes?.[ply - 1];
      return (
        <button
          ref={current === ply ? currentRef : undefined}
          type="button"
          className={`mv ${current === ply ? 'mv-current' : ''} ${cls ? `mv-${cls}` : ''}`}
          onClick={() => onSelect?.(ply)}
          disabled={!onSelect}
          aria-current={current === ply ? 'true' : undefined}
          aria-label={cls ? `${san}, ${CLASS_LABELS[cls]}` : undefined}
          title={cls ? CLASS_LABELS[cls] : undefined}
        >
          {san}
          {cls ? CLASS_MARKS[cls] : ''}
        </button>
      );
    };
    rows.push(
      <div className="mv-row" key={i}>
        <span className="mv-num">{startNumber + i / 2}.</span>
        {cell(i)}
        {cell(i + 1)}
      </div>,
    );
  }
  return (
    <div className="movelist" ref={end} tabIndex={0} role="group" aria-label="Moves">
      {rows.length ? rows : <p className="muted small">No moves yet.</p>}
    </div>
  );
}

/** Copy and download buttons for a game's PGN. */
export function PgnActions({ pgn, name = 'gridtheory-game' }: { pgn: string; name?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="btn-row">
      <button
        type="button"
        className="btn btn-quiet"
        onClick={() => {
          void navigator.clipboard?.writeText(pgn).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check size={16} aria-hidden="true" /> : <ClipboardCopy size={16} aria-hidden="true" />}
        {copied ? 'Copied' : 'Copy PGN'}
      </button>
      <a className="btn btn-quiet" download={`${name}.pgn`} href={`data:application/x-chess-pgn;charset=utf-8,${encodeURIComponent(pgn)}`}>
        <Download size={16} aria-hidden="true" />
        Download
      </a>
    </div>
  );
}

/** Screen-reader announcements of moves and game events. */
export function LiveRegion({ text }: { text: string }) {
  return (
    <div className="sr-only" role="status" aria-live="polite">
      {text}
    </div>
  );
}

/** Lets a move be typed in notation, for keyboard and screen-reader players. */
export function MoveInput({ fen, disabled, onMove }: { fen: string; disabled: boolean; onMove: (from: string, to: string, promotion?: string) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState(false);
  return (
    <form
      className="move-input"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !text.trim()) return;
        try {
          const move = new Chess(fen).move(text.trim().replace(/^0-0-0/, 'O-O-O').replace(/^0-0/, 'O-O'));
          onMove(move.from, move.to, move.promotion);
          setText('');
          setError(false);
        } catch {
          setError(true);
        }
      }}
    >
      <label htmlFor="move-text" className="sr-only">Type a move in notation</label>
      <input
        id="move-text"
        value={text}
        placeholder="Type a move, like Nf3"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error}
        onChange={(event) => {
          setText(event.target.value);
          setError(false);
        }}
      />
      {error && <span className="error small" role="alert">Not a legal move here.</span>}
    </form>
  );
}
