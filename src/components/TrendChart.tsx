import { useId, useState } from 'react';

export interface TrendPoint {
  t: number;
  value: number;
}

const WIDTH = 640;
const HEIGHT = 170;
const PAD = { left: 44, right: 12, top: 12, bottom: 24 };

const shortDate = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** A single-series line over time, with a hover readout and a table view for anyone who can't use the chart. */
export function TrendChart({ title, points, unit = '' }: { title: string; points: TrendPoint[]; unit?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  if (points.length < 2) {
    return (
      <figure className="trend">
        <figcaption>{title}</figcaption>
        <p className="muted small">Not enough history yet. This fills in as you play.</p>
      </figure>
    );
  }
  const values = points.map((point) => point.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = Math.max(high - low, 10);
  const min = low - span * 0.1;
  const max = high + span * 0.1;
  const x = (index: number) => PAD.left + (index / (points.length - 1)) * (WIDTH - PAD.left - PAD.right);
  const y = (value: number) => PAD.top + (1 - (value - min) / (max - min)) * (HEIGHT - PAD.top - PAD.bottom);
  const line = points.map((point, index) => `${x(index)},${y(point.value)}`).join(' ');
  const shown = hover === null ? null : points[hover];
  const last = points[points.length - 1];

  function move(clientX: number, rect: DOMRect) {
    const position = ((clientX - rect.left) / rect.width) * WIDTH;
    const fraction = (position - PAD.left) / (WIDTH - PAD.left - PAD.right);
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(fraction * (points.length - 1)))));
  }

  return (
    <figure className="trend">
      <figcaption id={titleId}>
        {title}
        <strong>{shown ? `${Math.round(shown.value)}${unit} · ${shortDate(shown.t)}` : `${Math.round(last.value)}${unit}`}</strong>
      </figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-labelledby={titleId}
        onPointerMove={(event) => move(event.clientX, event.currentTarget.getBoundingClientRect())}
        onPointerLeave={() => setHover(null)}
      >
        {[low, high].map((value) => (
          <g key={value}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(value)} y2={y(value)} className="trend-grid" />
            <text x={PAD.left - 8} y={y(value) + 4} textAnchor="end" className="trend-axis">{Math.round(value)}</text>
          </g>
        ))}
        <text x={PAD.left} y={HEIGHT - 6} className="trend-axis">{shortDate(points[0].t)}</text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 6} textAnchor="end" className="trend-axis">{shortDate(last.t)}</text>
        <polyline points={line} className="trend-line" />
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="trend-cursor" />
            <circle cx={x(hover)} cy={y(points[hover].value)} r="5" className="trend-dot" />
          </>
        )}
      </svg>
      <details className="trend-table">
        <summary>Show as a table</summary>
        <table>
          <thead><tr><th scope="col">Date</th><th scope="col">Value</th></tr></thead>
          <tbody>
            {[...points].reverse().slice(0, 30).map((point, index) => (
              <tr key={index}><td>{shortDate(point.t)}</td><td>{Math.round(point.value)}{unit}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
