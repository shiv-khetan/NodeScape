const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { APP, offline, openServer, nav } = require('./helpers');
const F = require('./fixtures');
const readState = page => page.evaluate(async () => {
  const { state } = await import('/state.js');
  return { snap: state.snap, histories: [...state.histories] };
});
const release = page => page.evaluate(() => window.__pending.shift()());
async function editConfig(page, config) {
  await page.getByRole('button', {name:'Manage servers',exact:true}).click();
  await page.getByRole('button', {name:'Edit',exact:true}).first().click();
  await page.getByLabel('SSH config file', {exact:true}).fill(config);
  await page.getByRole('button', {name:'Save changes',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Edit server'})).toHaveCount(0);
  await nav(page,'Overview');
}
const switchHost = async (page, host) => {
  await page.locator('#host').selectOption(host);
};

test('production has no demo script, host, globals or seeded history', async ({ page }) => {
  const requests = [];
  page.on('request', r => requests.push(new URL(r.url()).pathname));
  await openServer(page, { snapshot: F.SNAPSHOT, hosts: ['testbox'] });
  await expect(page.locator('.hero h1')).toHaveText('Overview');
  expect(requests).not.toContain('/demo.js');
  await expect(page.locator('script[src="app.js"]')).toHaveAttribute('type', 'module');
  const src = path.join(__dirname, '../src');
  const adapters = fs.readdirSync(src, { recursive: true }).filter(file => file.endsWith('.js') && fs.readFileSync(path.join(src, file), 'utf8').includes('window.__TAURI__'));
  expect(adapters).toEqual(['backend.js']);
  expect(fs.existsSync(path.join(__dirname, '../src/demo.js'))).toBe(false);
  await expect(page.locator('#hosts option[value="demo"]')).toHaveCount(0);
  expect(await page.evaluate(() => [typeof window.demoInvoke, typeof window.demoHistory])).toEqual(['undefined', 'undefined']);
  expect((await readState(page)).histories.map(([, h]) => h.cpu)).toEqual([[50]]);
  await expect(page.getByText('Collecting samples…')).toBeVisible();
});

test('without Tauri the desktop requirement is clear on every route', async ({ page }) => {
  await offline(page);
  await page.goto(APP);
  await expect(page.locator('.empty h1')).toHaveText('NodeScape needs its desktop app to run');
  for (const name of ['Services', 'Processes', 'Logs', 'Scheduled', 'Overview']) {
    await nav(page, name);
    await expect(page.locator('.empty h1')).toHaveText('NodeScape needs its desktop app to run');
  }
});

test('no chosen host asks the user to add a server and makes no remote query', async ({ page }) => {
  await openServer(page, {}, null);
  await expect(page.locator('.hero h1')).toHaveText('Add a server');
  await expect(page.locator('#host')).toHaveValue('');
  expect(await page.evaluate(() => window.__calls.some(c => ['query','logs','network_read'].includes(c.cmd)))).toBe(false);
  expect((await readState(page)).histories).toEqual([]);
});

test('slow A response arriving after B cannot change any snapshot or history', async ({ page }) => {
  await openServer(page, {
    'testbox:snapshot': { defer: true, value: F.SNAPSHOT },
    'nas-01:snapshot': F.SNAPSHOT.replace('@host\ntestbox', '@host\nnas-01').replace('150 0 150 900', '120 0 120 960'),
  });
  await expect.poll(() => page.evaluate(() => window.__pending.length)).toBe(1);
  await switchHost(page, 'nas-01');
  await expect(page.locator('.stats .on b')).toHaveText('20%');
  const before = await readState(page);
  await release(page);
  await expect.poll(() => readState(page)).toEqual(before);
  // A later action must still render B's snapshot and unpolluted history.
  await page.locator('[data-act="live"]').click();
  await expect(page.locator('.stats .on b')).toHaveText('20%');
  expect(await readState(page)).toEqual(before);
});

test('older same-host request cannot append a sample', async ({ page }) => {
  await openServer(page, { snapshot: { defer: true, value: F.SNAPSHOT } });
  await expect.poll(() => page.evaluate(() => window.__pending.length)).toBe(1);
  await page.locator('#refresh').click();
  await expect.poll(() => page.evaluate(() => window.__pending.length)).toBe(2);
  await page.evaluate(() => window.__pending.pop()());
  await expect(page.locator('.hero h1')).toHaveText('Overview');
  const before = await readState(page);
  await release(page);
  await page.locator('[data-act="live"]').click();
  expect(await readState(page)).toEqual(before);
});

test('rapid page changes drop old responses before state changes', async ({ page }) => {
  await openServer(page, {
    snapshot: { defer: true, value: F.SNAPSHOT },
    logs: { defer: true, value: F.LOGS_LIMITED },
    processes: F.PROCESSES,
  });
  await expect.poll(() => page.evaluate(() => window.__pending.length)).toBe(1);
  await nav(page, 'Services');
  await nav(page, 'Logs');
  await nav(page, 'Processes');
  await expect(page.locator('.hero h1')).toHaveText('Processes');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.evaluate(() => window.__pending.splice(0).forEach(resolve => resolve()));
  expect(await readState(page)).toEqual({ snap: null, histories: [] });
  await expect(page.locator('.hero h1')).toHaveText('Processes');
});

test('clearing the host invalidates an in-flight response', async ({ page }) => {
  await openServer(page, { snapshot: { defer: true, value: F.SNAPSHOT } });
  await expect.poll(() => page.evaluate(() => window.__pending.length)).toBe(1);
  await switchHost(page, '');
  await expect(page.locator('.hero h1')).toHaveText('Add a server');
  await release(page);
  expect(await readState(page)).toEqual({ snap: null, histories: [] });
  await expect(page.locator('.hero h1')).toHaveText('Add a server');
});

test('history is retained per host and isolated across SSH configs', async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT });
  await expect(page.locator('.hero h1')).toHaveText('Overview');
  await page.locator('[data-act="live"]').click();
  await switchHost(page, 'nas-01');
  await expect.poll(async () => (await readState(page)).histories.length).toBe(2);
  await switchHost(page, 'testbox');
  await expect.poll(async () => (await readState(page)).histories.map(([, h]) => h.cpu.length)).toEqual([2, 1]);
  await editConfig(page, 'C:\\test-config');
  await expect.poll(async () => (await readState(page)).histories.map(([, h]) => h.cpu.length)).toEqual([2, 1, 1]);
});

test('editing a profile config invalidates pending snapshots', async ({ page }) => {
  await openServer(page, { snapshot: { defer: true, value: F.SNAPSHOT } });
  await expect.poll(() => page.evaluate(() => window.__pending.length)).toBe(1);
  await editConfig(page, 'C:\\test-config');
  await expect.poll(() => page.evaluate(() => window.__pending.length)).toBe(2);
  await page.evaluate(() => window.__pending.pop()());
  await expect(page.locator('.hero h1')).toHaveText('Overview');
  const before = await readState(page);
  await page.evaluate(() => window.__pending.splice(0).forEach(resolve => resolve()));
  expect(await readState(page)).toEqual(before);
  expect(before.histories).toHaveLength(1);
  expect(JSON.parse(before.histories[0][0]).config).toBe('C:\\test-config');
});

test('backend adapter preserves command arguments and typed errors', async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT });
  const results = await page.evaluate(async () => {
    const backend = await import('/backend.js');
    const target = { host: 'testbox', config: 'C:\\test-config' };
    const calls = [];
    window.__TAURI__.core.invoke = async (cmd, args) => { calls.push({ cmd, args }); return cmd === 'hosts' ? [] : 'ok'; };
    await backend.query(target, 'processes');
    await backend.logs(target, 'nginx', 100);
    await backend.serviceAction(target, 'nginx.service', 'restart');
    await backend.hosts(target.config);
    await backend.cancel('request-1');
    const errors = [];
    for (const error of [{ kind: 'timeout', message: 'Timed out' }, 'unexpected']) {
      window.__TAURI__.core.invoke = async () => { throw error; };
      try { await backend.query(target, 'snapshot'); } catch (err) { errors.push(err); }
    }
    return { calls, errors };
  });
  expect(results.calls).toEqual([
    { cmd: 'query', args: { host: 'testbox', config: 'C:\\test-config', what: 'processes' } },
    { cmd: 'logs', args: { host: 'testbox', config: 'C:\\test-config', unit: 'nginx', lines: 100 } },
    { cmd: 'service_action', args: { target: { host: 'testbox', config: 'C:\\test-config' }, scope: 'system', unit: 'nginx.service', action: 'restart' } },
    { cmd: 'hosts', args: { config: 'C:\\test-config' } },
    { cmd: 'operation_cancel', args: { id: 'request-1' } },
  ]);
  expect(results.errors).toEqual([{ kind: 'timeout', message: 'Timed out' }, { kind: 'internal', message: 'unexpected' }]);
});

test('the static server exposes only app and fixture files', async ({ request }) => {
  for (const file of ['app.js', 'pages/overview.js', 'tests/fixtures/demo-backend.js']) {
    const response = await request.get(APP + file);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('text/javascript');
  }
  expect((await request.get(APP + 'package.json')).status()).toBe(404);
  expect((await request.get(APP + 'tests/fixtures/%2e%2e%2f%2e%2e%2fpackage.json')).status()).toBe(403);
});

test('a legacy demo selection starts with an empty server state', async ({ page }) => {
  await openServer(page, {}, 'demo');
  await expect(page.locator('.hero h1')).toHaveText('Add a server');
  await expect(page.locator('#host')).toHaveValue('');
  expect(await page.evaluate(() => window.__calls.some(c => c.cmd === 'query'))).toBe(false);
  expect((await readState(page)).histories).toEqual([]);
});
