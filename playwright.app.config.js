const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: 'tests/app',
  projects: [{ name: 'app' }],
  globalSetup: require.resolve('./tests/app/build'),
  workers: 1,
  timeout: 60000,
  expect: { timeout: 20000 },
  reporter: [['list']],
  outputDir: 'tests/test-results/app',
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
