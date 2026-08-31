import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    // The prompt builders require these env vars (no baked-in defaults).
    // Tests run against the in-repo synthetic fixtures.
    env: {
      HUGO_WORKFLOW_PATH: fileURLToPath(new URL('./fixtures/hugo-workflow-fixture.ts', import.meta.url)),
      MURMUR8_APPSETTINGS_PATH: fileURLToPath(
        new URL('./fixtures/murmur8-appsettings-fixture.json', import.meta.url),
      ),
    },
  },
});
