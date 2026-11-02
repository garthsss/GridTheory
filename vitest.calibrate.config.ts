import { defineConfig } from 'vitest/config';

// Very slow: plays a full bot tournament to measure ratings. Run with `npm run calibrate`.
export default defineConfig({
  test: {
    include: ['tests/calibrate.run.ts'],
    testTimeout: 6 * 60 * 60 * 1000,
  },
});
