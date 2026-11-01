// Every saved server shows its health, so "is anything wrong anywhere?" needs no switching.
const { test, expect } = require('@playwright/test');
const { openServer, nav, APP, installBackend } = require('./helpers');
const F = require('./fixtures');

const healthCalls = page => page.evaluate(() => window.__calls.filter(c => c.cmd === 'server_health').map(c => c.args.target.host));
const item = (page, name) => page.locator('.fleet button', { hasText: name });

test('sidebar lists each server with its health; the current one comes from its snapshot', async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT, 'nas-01:server_health': { failed: 2 } });
  await expect(page.locator('.hero h1')).toHaveText('Overview');
  const fleet = page.getByRole('list', { name: 'Server health' });
  await expect(fleet).toBeVisible();
  await expect(item(page, 'testbox')).toContainText('1 failed');
  await expect(item(page, 'testbox')).toHaveAttribute('aria-current', 'true');
  await expect(item(page, 'nas-01')).toContainText('2 failed');
  await expect(item(page, 'nas-01').locator('.health-dot')).toHaveClass(/failed/);
  expect(await healthCalls(page)).toEqual(['nas-01']);
});

test('unreachable and login-needed servers say so; healthy ones read healthy', async ({ page }) => {
  await installBackend(page, { host: 'alpha', responses: { snapshot: F.SNAPSHOT,
    'testbox:server_health': { error: { kind: 'unreachable', message: 'No route to host' } },
    'nas-01:server_health': { error: { kind: 'password_required', message: 'Permission denied (publickey,password).' } } } });
  await page.goto(APP);
  await expect(item(page, 'testbox')).toContainText('unreachable');
  await expect(item(page, 'testbox').locator('.health-dot')).toHaveClass(/warn/);
  await expect(item(page, 'nas-01')).toContainText('needs login');
  await page.evaluate(() => { const old = window.__TAURI__.core.invoke; window.__TAURI__.core.invoke = (c, a) => c === 'server_health' ? Promise.resolve({ failed: 0 }) : old(c, a); });
  await page.locator('#refresh').click();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('switch to testbox');
  await expect(page.locator('.palette [role=option]').first()).toContainText('unreachable');
});

test('clicking a server in the list switches to it', async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT, 'nas-01:server_health': { failed: 0 } });
  await expect(item(page, 'nas-01')).toContainText('healthy');
  await item(page, 'nas-01').click();
  await expect(page.locator('#host option:checked')).toHaveText('nas-01');
  await expect(item(page, 'nas-01')).toHaveAttribute('aria-current', 'true');
});

test('servers are re-checked in the background every two minutes', async ({ page }) => {
  await page.clock.install();
  await openServer(page, { snapshot: F.SNAPSHOT, 'nas-01:server_health': { failed: 0 } });
  await expect(item(page, 'nas-01')).toContainText('healthy');
  const before = (await healthCalls(page)).length;
  await page.clock.fastForward(121_000);
  await expect.poll(async () => (await healthCalls(page)).length).toBeGreaterThan(before);
});

test('Manage servers shows a status column, and the collapsed sidebar tile carries the current status', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openServer(page, { snapshot: F.SNAPSHOT, 'nas-01:server_health': { failed: 2 } });
  await expect(page.locator('.hostbox')).toHaveAttribute('data-health', 'failed');
  await expect(page.locator('.fleet')).toBeHidden();
  await page.locator('#manageServers').click();
  await expect(page.locator('thead th')).toContainText(['Status']);
  await expect(page.locator('tr', { hasText: 'nas-01' })).toContainText('2 failed');
});

test('a single server shows no fleet list', async ({ page }) => {
  await installBackend(page, { host: 'solo', profiles: [{ id: 'p1', name: 'solo', host: 'solo', config: null }], responses: { snapshot: F.SNAPSHOT } });
  await page.goto(APP);
  await expect(page.locator('.hero h1')).toHaveText('Overview');
  await expect(page.locator('.fleet')).toHaveCount(0);
});
