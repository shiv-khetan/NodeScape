const { test: base, expect, chromium } = require('@playwright/test');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const root = path.join(__dirname, '../..');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function hostSettings() {
  // Same location as the Rust real-SSH suites (../ relative to src-tauri).
  let text;
  try { text = await fs.readFile(path.join(root, '.env.test.local'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const values = Object.fromEntries(text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#')).map(line => {
    const i = line.indexOf('=');
    if (i < 1) throw new Error('Invalid real-SSH test settings');
    return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2')];
  }));
  const settings = {
    host: values.NODESCAPE_TEST_HOST, config: values.NODESCAPE_TEST_SSH_CONFIG, dir: values.NODESCAPE_TEST_DIR,
  };
  if (!settings.host || !settings.config || !settings.dir?.startsWith('/')) throw new Error('Real-SSH test settings require host, config and an absolute test directory');
  return settings;
}
async function launch(profile) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'nodescape-app-'));
  const config = path.join(folder, 'config');
  await fs.mkdir(config);
  let child, browser, launchError;
  try {
    if (profile) await fs.writeFile(path.join(config, 'profiles.json'), JSON.stringify({ version: 1, profiles: [profile] }));
    const port = await freePort();
    // Clear inherited WebView options so these tests always own their isolated instance.
    child = spawn(path.join(root, 'src-tauri/target/debug/nodescape.exe'), [], {
      cwd: root, windowsHide: true, stdio: 'ignore', env: {
        ...process.env, NODESCAPE_CONFIG_DIR: config,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
        WEBVIEW2_USER_DATA_FOLDER: path.join(folder, 'webview'),
      },
    });
    child.on('error', () => { launchError = true; });
    const endpoint = 'http://127.0.0.1:' + port;
    await expect.poll(async () => {
      if (launchError || child.exitCode !== null) throw new Error('Debug app exited before CDP was ready');
      try { return (await (await fetch(endpoint + '/json/list')).json()).some(target => target.type === 'page'); } catch { return false; }
    }, { timeout: 30000, message: 'Debug app must expose a WebView2 page target' }).toBe(true);
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    await expect.poll(() => context.pages().length).toBeGreaterThan(0);
    const page = context.pages()[0];
    await page.waitForFunction(() => typeof window.__TAURI__?.core?.invoke === 'function');
    if (profile) await expect.poll(() => page.locator('#host').inputValue().then(id => id === profile.id)).toBe(true);
    else await expect(page.locator('.hero h1')).toHaveText('Add a server');
    return { page, close };
  } catch (error) { await close(); throw error; }

  async function close() {
    try { await browser?.close(); }
    finally {
      if (child?.pid && child.exitCode === null) {
        const stopped = new Promise(resolve => child.once('exit', resolve));
        const result = spawnSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
        if (result.status !== 0 && child.exitCode === null) child.kill();
        await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 5000))]);
      }
      await fs.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}
const test = base.extend({
  app: async ({}, use) => {
    const app = await launch();
    try { await use(app.page); } finally { await app.close(); }
  },
  hostApp: async ({}, use) => {
    const settings = await hostSettings();
    base.skip(!settings, 'No .env.test.local; real-host app tests are optional');
    const app = await launch({ id: 'app-test', name: 'Test server', host: settings.host, config: settings.config });
    try { await use({ page: app.page, settings }); } finally { await app.close(); }
  },
});
module.exports = { test, expect };
