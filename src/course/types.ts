export interface ReadStep {
  kind: 'read';
  text: string;
  /** Position to show: a FEN, or `moves` replayed from the start. Omit to keep the board as it was. */
  fen?: string;
  moves?: string;
  arrows?: [string, string][];
  marks?: string[];
}

export interface PlayStep {
  kind: 'play';
  text: string;
  fen?: string;
  /** Moves replayed from the start to reach the position, as an alternative to a FEN. */
  from?: string;
  /** The line to find: the player's moves, alternating with scripted replies. */
  line: string[];
  /** Other first moves that are also correct. Playing one finishes the exercise. */
  also?: string[];
  hint: string;
  done: string;
  /** Skip the engine check for non-tactical exercises, such as rule drills. */
  drill?: boolean;
  /** Accept any move the engine rates close to its best, for positions with several good plans. */
  judge?: 'engine';
}

export interface GameStep {
  kind: 'game';
  text: string;
  white: string;
  black: string;
  event: string;
  /** Full game as SAN, space separated. */
  moves: string;
  /** Comments keyed by ply, where 1 is White's first move. */
  notes: Record<number, string>;
}

export type Step = ReadStep | PlayStep | GameStep;

export interface Lesson {
  id: string;
  title: string;
  summary: string;
  steps: Step[];
}

export interface Level {
  id: string;
  title: string;
  rating: string;
  intro: string;
  /** Real books whose teaching order this level follows, for further reading. */
  reading: string[];
  lessons: Lesson[];
}
