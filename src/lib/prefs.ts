import { useEffect, useState } from 'react';
import { store } from './store';

export type ThemeMode = 'system' | 'dark' | 'light';
export type BoardTheme = 'graphite' | 'walnut' | 'moss' | 'marine' | 'contrast';
export type AnimationSpeed = 'off' | 'fast' | 'normal';

export interface Prefs {
  theme: ThemeMode;
  board: BoardTheme;
  animation: AnimationSpeed;
  sound: boolean;
  coordinates: boolean;
  legalDots: boolean;
  autoQueen: boolean;
}

export const BOARD_THEMES: { id: BoardTheme; label: string; light: string; dark: string }[] = [
  { id: 'graphite', label: 'Graphite', light: '#dfe3e8', dark: '#6b7c8f' },
  { id: 'walnut', label: 'Walnut', light: '#ecd9b9', dark: '#a9794f' },
  { id: 'moss', label: 'Moss', light: '#e9edcf', dark: '#6f9457' },
  { id: 'marine', label: 'Marine', light: '#dbe9ee', dark: '#4f83a3' },
  { id: 'contrast', label: 'High contrast', light: '#ffffff', dark: '#3a3a3a' },
];

export const ANIMATION_MS: Record<AnimationSpeed, number> = { off: 0, fast: 90, normal: 150 };

const DEFAULTS: Prefs = {
  theme: 'system',
  board: 'graphite',
  animation: 'normal',
  sound: true,
  coordinates: true,
  legalDots: true,
  autoQueen: false,
};

let cached: Prefs | null = null;
const listeners = new Set<(prefs: Prefs) => void>();

export function loadPrefs(): Prefs {
  if (cached) return cached;
  cached = { ...DEFAULTS, ...store.get<Partial<Prefs>>('prefs', {}) };
  return cached;
}

export function savePrefs(patch: Partial<Prefs>) {
  cached = { ...loadPrefs(), ...patch };
  store.set('prefs', cached);
  for (const listener of listeners) listener(cached);
}

export function usePrefs(): Prefs {
  const [prefs, setPrefs] = useState(loadPrefs);
  useEffect(() => {
    listeners.add(setPrefs);
    return () => {
      listeners.delete(setPrefs);
    };
  }, []);
  return prefs;
}

/** Applies theme and board colours to the document. */
export function applyPrefs(prefs: Prefs) {
  const root = document.documentElement;
  if (prefs.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = prefs.theme;
  const board = BOARD_THEMES.find((theme) => theme.id === prefs.board) ?? BOARD_THEMES[0];
  root.style.setProperty('--sq-light', board.light);
  root.style.setProperty('--sq-dark', board.dark);
  root.style.setProperty('--piece-ms', `${ANIMATION_MS[prefs.animation]}ms`);
}
