import type { Color } from 'chess.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChessClock } from '../core/clock';

export { botThinkTime, flagResult } from '../core/clock';

export interface TimeControl {
  id: string;
  label: string;
  category: string;
  /** Starting time in seconds. */
  seconds: number;
  increment: number;
}

export const TIME_CONTROLS: TimeControl[] = [
  { id: '1+0', label: '1 min', category: 'Bullet', seconds: 60, increment: 0 },
  { id: '2+1', label: '2 | 1', category: 'Bullet', seconds: 120, increment: 1 },
  { id: '3+0', label: '3 min', category: 'Blitz', seconds: 180, increment: 0 },
  { id: '3+2', label: '3 | 2', category: 'Blitz', seconds: 180, increment: 2 },
  { id: '5+0', label: '5 min', category: 'Blitz', seconds: 300, increment: 0 },
  { id: '5+3', label: '5 | 3', category: 'Blitz', seconds: 300, increment: 3 },
  { id: '10+0', label: '10 min', category: 'Rapid', seconds: 600, increment: 0 },
  { id: '15+10', label: '15 | 10', category: 'Rapid', seconds: 900, increment: 10 },
  { id: '30+0', label: '30 min', category: 'Classical', seconds: 1800, increment: 0 },
];

export const timeControlById = (id: string) => TIME_CONTROLS.find((tc) => tc.id === id) ?? null;

/** Formats remaining time: tenths under 20 seconds, as tournament clocks do. */
export function formatClock(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 20_000) {
    const tenths = Math.floor(clamped / 100);
    return `0:${String(Math.floor(tenths / 10)).padStart(2, '0')}.${tenths % 10}`;
  }
  const total = Math.ceil(clamped / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

export interface ClockState {
  w: number;
  b: number;
}

/** Runs a ChessClock on screen. `active` is whichever side is running, or null when paused. */
export function useClock(control: TimeControl | null, onFlag: (side: Color) => void) {
  const model = useMemo(() => new ChessClock((control?.seconds ?? 0) * 1000, (control?.increment ?? 0) * 1000), [control]);
  const [times, setTimes] = useState<ClockState>({ w: model.remaining.w, b: model.remaining.b });
  const [active, setActive] = useState<Color | null>(null);
  const flagged = useRef(false);
  const onFlagRef = useRef(onFlag);
  onFlagRef.current = onFlag;

  useEffect(() => {
    if (!control || !active) return;
    const timer = window.setInterval(() => {
      const reading = model.read(performance.now());
      setTimes({ w: reading.w, b: reading.b });
      if (reading.flagged && !flagged.current) {
        flagged.current = true;
        model.pause(performance.now());
        setActive(null);
        onFlagRef.current(reading.flagged);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [active, control, model]);

  const start = useCallback((side: Color) => {
    model.start(side, performance.now());
    setActive(side);
  }, [model]);

  const pause = useCallback(() => {
    model.pause(performance.now());
    setActive(null);
  }, [model]);

  const addIncrement = useCallback((side: Color) => {
    model.addIncrement(side);
    setTimes({ w: model.remaining.w, b: model.remaining.b });
  }, [model]);

  const restore = useCallback((state: ClockState) => {
    model.restore(state);
    flagged.current = false;
    setTimes({ ...state });
  }, [model]);

  const snapshot = useCallback((): ClockState => {
    const reading = model.read(performance.now());
    return { w: reading.w, b: reading.b };
  }, [model]);

  return { times, active, start, pause, addIncrement, restore, snapshot };
}
