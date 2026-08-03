import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests only; the e2e runner (npm run test:run) hits the live API separately.
    include: ['src/tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
