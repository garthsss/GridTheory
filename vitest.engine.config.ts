import { defineConfig } from 'vitest/config';

// Slow suite: runs real Stockfish over the course content and the bot ladder.
export default defineConfig({
  test: {
    include: ['tests/**/*.engine.test.ts'],
    testTimeout: 900_000,
  },
});
