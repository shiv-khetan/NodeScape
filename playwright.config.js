// Native modules are served locally; fixtures provide the desktop backend.
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: 'tests',
  testIgnore: 'app/**',
  projects: [{ name: 'frontend' }],
  fullyParallel: true,
  workers: 4,
  reporter: [['list']],
  outputDir: 'tests/test-results',
  webServer: { command: 'node tests/serve.js', url: `http://127.0.0.1:${process.env.NODESCAPE_TEST_PORT || 4174}`, reuseExistingServer: false },
  use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } },
});
