import { loadPrefs } from './prefs';

type SoundName = 'move' | 'capture' | 'check' | 'end' | 'correct' | 'wrong' | 'low';

let context: AudioContext | null = null;

const RECIPES: Record<SoundName, [number, number, number][]> = {
  // Each note: frequency in Hz, start in seconds, duration in seconds.
  move: [[520, 0, 0.05]],
  capture: [[300, 0, 0.05], [220, 0.04, 0.07]],
  check: [[740, 0, 0.06], [880, 0.07, 0.08]],
  end: [[440, 0, 0.12], [554, 0.12, 0.12], [659, 0.24, 0.2]],
  correct: [[660, 0, 0.07], [880, 0.07, 0.1]],
  wrong: [[220, 0, 0.14]],
  low: [[1000, 0, 0.04]],
};

/** Short synthesised sounds, so that no audio files need to ship with the app. */
export function playSound(name: SoundName) {
  if (!loadPrefs().sound) return;
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume();
    const now = context.currentTime;
    for (const [frequency, start, duration] of RECIPES[name]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(0.12, now + start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now + start);
      oscillator.stop(now + start + duration + 0.02);
    }
  } catch {
    // Sound is an extra, so a browser without audio just stays silent.
  }
}

/** Picks a sound for a move from its SAN. */
export function moveSound(san: string): SoundName {
  if (san.includes('+') || san.includes('#')) return 'check';
  if (san.includes('x')) return 'capture';
  return 'move';
}
