const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { APP, installBackend, nav } = require('./helpers');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const config = JSON.parse(read('src-tauri/tauri.conf.json'));

test('every registered app command is enrolled and granted only to main', () => {
  const handlers = read('src-tauri/src/main.rs').split('tauri::generate_handler![')[1].split('])')[0]
    .split(',').map(s => s.trim().split('::').at(-1)).filter(Boolean).sort();
  const build = read('src-tauri/build.rs');
  expect(build).toContain('AppManifest::new().commands(');
  expect(build).toContain('tauri_build::try_build(');
  const commands = [...build.matchAll(/"([a-z_]+)"/g)].map(m => m[1]).sort();
  expect(commands).toEqual(handlers);
  const commandFiles = fs.readdirSync(path.join(__dirname, '../src-tauri/src')).filter(f => f.endsWith('.rs'));
  const defined = commandFiles.flatMap(f => [...read('src-tauri/src/' + f).matchAll(/#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g)].map(m => m[1])).sort();
  expect(commands).toEqual(defined);
  const capabilities = fs.readdirSync(path.join(__dirname, '../src-tauri/capabilities'));
  expect(capabilities).toEqual(['default.json']);
  const capability = JSON.parse(read('src-tauri/capabilities/default.json'));
  expect(capability.windows).toEqual(['main']);
  expect(capability.remote).toBeUndefined();
  expect(capability.webviews).toBeUndefined();
  expect(capability.permissions.slice().sort()).toEqual([
    ...handlers.map(c => 'allow-' + c.replaceAll('_', '-')),
    'dialog:allow-open', 'dialog:allow-save',
  ].sort());
});

test('CSP permits local assets and IPC with no script escape hatch', () => {
  const csp = config.app.security.csp;
  expect(typeof csp).toBe('string');
  const rules = Object.fromEntries(csp.split(';').filter(s => s.trim()).map(s => { const [key, ...values] = s.trim().split(/\s+/); return [key, values]; }));
  expect(rules).toEqual({
    'default-src': ["'none'"], 'script-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"], 'font-src': ["'self'"], 'img-src': ["'self'"],
    'connect-src': ['ipc:', 'http://ipc.localhost'], 'object-src': ["'none'"],
    'frame-ancestors': ["'none'"], 'base-uri': ["'none'"], 'form-action': ["'none'"],
  });
  expect(read('src/index.html')).not.toMatch(/<script(?![^>]*\bsrc=)|\son\w+=/i);
  expect(config.build.frontendDist).toBe('../src');
});

test('CSP header blocks inline script, eval and external connections; charts and xterm run', async ({ page }) => {
  await installBackend(page);
  const response = await page.goto(APP);
  expect(response.headers()['content-security-policy']).toBe(config.app.security.csp);
  await expect(page.locator('.hero h1')).toHaveText('Overview');
  for (let n=2;n<=5;n++) {
    await page.locator('#refresh').click();
    await expect.poll(()=>page.evaluate(async()=>(await import('/state.js')).history().cpu.length)).toBe(n);
  }
  await expect(page.locator('.step svg')).toBeVisible();
  expect(await page.locator('.meter .track i').first().evaluate(el => parseFloat(getComputedStyle(el).width))).toBeGreaterThan(0);
  const result = await page.evaluate(async () => {
    const violations = [];
    document.addEventListener('securitypolicyviolation', e => violations.push(e.effectiveDirective));
    const script = document.createElement('script'); script.textContent = 'window.inlineRan = true'; document.head.append(script);
    // CDP evaluation bypasses eval CSP; run the probe as a normal self-hosted script.
    await new Promise((resolve, reject) => { const probe = document.createElement('script'); probe.src = '/tests/fixtures/csp-probe.js'; probe.onload = resolve; probe.onerror = reject; document.head.append(probe); });
    const evalBlocked = window.evalBlocked;
    let connectBlocked = false; try { await fetch('https://blocked.invalid'); } catch { connectBlocked = true; }
    await new Promise(resolve => setTimeout(resolve, 50));
    return { inlineRan: !!window.inlineRan, evalRan: !!window.evalRan, evalBlocked, connectBlocked, violations };
  });
  expect(result.inlineRan).toBe(false); expect(result.evalRan).toBe(false);
  expect(result.evalBlocked).toBe(true); expect(result.connectBlocked).toBe(true);
  expect(result.violations).toContain('script-src-elem'); expect(result.violations).toContain('connect-src');
  await nav(page, 'Terminal');
  await expect(page.locator('[data-terminal-status]')).toHaveText('Connected');
  await expect(page.locator('.xterm-rows')).toContainText('Connected to');
});

test('terminal copy describes strict operations and explicit host approval accurately', async ({ page }) => {
  await installBackend(page); await page.goto(APP); await nav(page, 'Terminal');
  await expect(page.locator('#main')).not.toContainText('Unknown host keys are always refused');
});
