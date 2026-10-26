// UI tests run against src/ in plain Chromium: no Tauri, no SSH.
// Demo mode covers the full app; a fake window.__TAURI__ covers the real-server code paths.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  reporter: [['list']],
  use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } },
});
