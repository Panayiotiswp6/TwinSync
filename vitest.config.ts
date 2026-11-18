import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests never touch the network or the persistent state file.
    env: { TWINSYNC_EPHEMERAL: '1', AI_PROVIDER: 'demo' },
  },
});
