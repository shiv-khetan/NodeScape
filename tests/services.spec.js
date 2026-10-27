const { test, expect } = require('@playwright/test');
const { openServer, nav } = require('./helpers');
const F = require('./fixtures');

const unit = (name, active = 'active', sub = 'running', enabled = 'enabled', description = 'Example service') => ({ name, load: 'loaded', active, sub, enabled, description });
const data = () => ({
  system: { units: [unit('web.service'), { ...unit('cold.service', 'inactive', 'dead', 'disabled'), load: 'not-loaded' }, unit('broken.service', 'failed', 'failed', 'static')] },
  user: { available: true, units: [unit('sync.service', 'inactive', 'dead', 'disabled', "Personal <img src=x onerror=alert(1)> 'sync'")] },
});
const calls = (page, cmd) => page.evaluate(cmd => window.__calls.filter(c => c.cmd === cmd), cmd);
async function open(page, overrides = {}) {
  await openServer(page, { snapshot: F.SNAPSHOT, services_read: data(), service_action: 'ok', ...overrides });
  await nav(page, 'Services');
  await expect(page.locator('.hero h1')).toHaveText('Services');
}
const row = (page, name) => page.locator('tbody tr', { hasText: name });

test('dedicated read shows both scopes, enabled states, installed units, and escaped descriptions', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('columnheader', { name: 'Enabled' })).toBeVisible();
  await expect(row(page, 'cold.service')).toContainText('disabled');
  await expect(row(page, 'cold.service')).toContainText('not-loaded');
  await expect(row(page, 'broken.service')).toContainText('static');
  expect(await calls(page, 'services_read')).toHaveLength(1);
  expect(await calls(page, 'query')).toHaveLength(1); // Overview only
  await page.locator('[data-scope="user"]').click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(row(page, 'sync.service')).toContainText("Personal <img src=x onerror=alert(1)> 'sync'");
  await expect(page.locator('#main img')).toHaveCount(0);
  await expect(page.locator('[data-scope="user"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'logs', exact: true })).toHaveCount(0);
  await page.locator('[data-scope="system"]').click();
  await expect(page.locator('tbody tr')).toHaveCount(3);
});

test('late service reads cannot replace a newer target', async ({ page }) => {
  const newer = data();
  newer.system.units = [unit('newer.service')];
  await openServer(page, {
    snapshot: F.SNAPSHOT,
    'testbox:services_read': { defer: true, value: data() },
    'nas-01:services_read': newer,
  });
  await nav(page, 'Services');
  await expect.poll(() => page.evaluate(() => window.__pending.length)).toBe(1);
  await page.locator('#host').selectOption('nas-01');
  await expect(row(page, 'newer.service')).toBeVisible();
  await page.evaluate(() => window.__pending.shift()());
  await expect(row(page, 'newer.service')).toBeVisible();
  await expect(row(page, 'web.service')).toHaveCount(0);
});

test('search and existing state tabs work on each scope', async ({ page }) => {
  await open(page);
  await page.locator('#filter').fill('cold');
  await expect(page.locator('tbody tr:visible')).toHaveCount(1);
  await page.locator('#filter').fill('');
  await page.locator('[data-state="failed"]').click();
  await expect(page.locator('tbody tr:visible')).toHaveCount(1);
  await page.locator('[data-scope="user"]').click();
  await expect(page.locator('#services-empty')).toBeVisible();
  await page.locator('[data-state="inactive"]').click();
  await expect(page.locator('tbody tr:visible')).toHaveCount(1);
});

for (const scope of ['system', 'user']) {
  test(scope + ' exposes all five actions; stop restart and disable confirm before invoking', async ({ page }) => {
    await open(page);
    await page.locator('[data-scope="' + scope + '"]').click();
    const name = scope === 'user' ? 'sync.service' : 'web.service';
    for (const action of ['stop', 'restart', 'disable']) {
      page.once('dialog', d => { expect(d.message()).toContain(name); return d.dismiss(); });
      await row(page, name).locator('[data-svc="' + action + '"]').click();
    }
    expect(await calls(page, 'service_action')).toHaveLength(0);
    for (const action of ['start', 'stop', 'restart', 'enable', 'disable']) {
      if (['stop', 'restart', 'disable'].includes(action)) page.once('dialog', d => d.accept());
      await row(page, name).locator('[data-svc="' + action + '"]').click();
      await expect.poll(async () => (await calls(page, 'service_action')).length).toBe(['start', 'stop', 'restart', 'enable', 'disable'].indexOf(action) + 1);
      await expect(page.locator('#toast')).toHaveText(action + ' ' + name + ': ok');
      await expect.poll(async () => (await calls(page, 'services_read')).length).toBe(['start', 'stop', 'restart', 'enable', 'disable'].indexOf(action) + 2);
    }
    for (const call of await calls(page, 'service_action')) {
      expect(call.args).toMatchObject({ target: { host: 'testbox', config: null }, scope, unit: name });
      if (scope === 'user') expect(call.args).not.toHaveProperty('password');
    }
  });
}

test('enable and disable refresh the enabled column in the deterministic fixture', async ({ page }) => {
  await openServer(page, null);
  await nav(page, 'Services');
  const service = row(page, 'backup.service');
  await service.locator('[data-svc="enable"]').click();
  await expect(service.locator('[data-enabled]')).toHaveText('enabled');
  page.once('dialog', d => d.accept());
  await service.locator('[data-svc="disable"]').click();
  await expect(service.locator('[data-enabled]')).toHaveText('disabled');
});

test('unavailable user manager explains account scope without breaking system services', async ({ page }) => {
  const services = data();
  services.user = { available: false, reason: 'user manager not running — services under this account only run while you are logged in unless lingering is enabled', units: [] };
  await open(page, { services_read: services });
  await page.locator('[data-scope="user"]').click();
  await expect(page.locator('#services-unavailable')).toContainText('lingering');
  await expect(page.locator('[data-svc]')).toHaveCount(0);
  await page.locator('[data-scope="system"]').click();
  await expect(row(page, 'web.service')).toBeVisible();
});

test('only system actions use the sudo dialog; user errors never prompt or retry', async ({ page }) => {
  await open(page, { service_action: [
    { error: { kind: 'sudo_required', message: 'Permission required' } }, 'ok',
    { error: { kind: 'sudo_required', message: 'Unexpected user permission failure' } },
  ] });
  await row(page, 'web.service').locator('[data-svc="start"]').click();
  const dialog = page.getByRole('dialog', { name: 'Administrator permission' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Run action' }).click();
  await expect(page.locator('#toast')).toContainText(': ok');
  await page.locator('[data-scope="user"]').click();
  await row(page, 'sync.service').locator('[data-svc="start"]').click();
  await expect(page.locator('#toast')).toHaveText('Unexpected user permission failure');
  await expect(page.locator('.sudo-dialog')).toHaveCount(0);
  expect(await calls(page, 'service_action')).toHaveLength(3);
});

for (const scope of ['system', 'user']) {
  test(scope + ' outcome_unknown refreshes state and never retries the mutation', async ({ page }) => {
    await open(page, { service_action: { error: { kind: 'outcome_unknown', message: 'Outcome unknown. Refreshing state.' } } });
    await page.locator('[data-scope="' + scope + '"]').click();
    await page.locator('[data-svc="start"]').first().click();
    await expect(page.locator('#toast')).toContainText('Outcome unknown');
    await expect.poll(async () => (await calls(page, 'services_read')).length).toBe(2);
    expect(await calls(page, 'service_action')).toHaveLength(1);
    await expect(page.locator('[data-scope="' + scope + '"]')).toHaveAttribute('aria-pressed', 'true');
  });
}

test('late mutation results do not refresh a different scope', async ({ page }) => {
  await open(page, { service_action: { defer: true, value: { error: { kind: 'outcome_unknown', message: 'Lost' } } } });
  await row(page, 'web.service').locator('[data-svc="start"]').click();
  await expect.poll(() => page.evaluate(() => window.__pending.length)).toBe(1);
  await page.locator('[data-scope="user"]').click();
  await page.evaluate(() => window.__pending.shift()());
  await expect(row(page, 'sync.service')).toBeVisible();
  expect(await calls(page, 'services_read')).toHaveLength(1);
  await expect(page.locator('#toast')).not.toContainText('Lost');
});

for (const [width, height] of [[800, 600], [1024, 768], [1280, 800], [1440, 900], [1920, 1080], [2560, 1440]]) {
  test('both scopes fit ' + width + 'x' + height, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const services = data();
    services.system.units[0].description = 'long description '.repeat(60);
    services.user.units[0].name = 'long-'.repeat(35) + '.service';
    await open(page, { services_read: services });
    for (const scope of ['system', 'user']) {
      await page.locator('[data-scope="' + scope + '"]').click();
      expect(await page.evaluate(() => {
        const selectors = ['header', '.hero', '.card'];
        return document.documentElement.scrollWidth <= innerWidth + 1 && [...document.querySelectorAll(selectors.join(','))].every(e => e.scrollWidth <= e.clientWidth + 1);
      })).toBe(true);
      const action = page.locator('[data-svc="disable"]').first();
      await expect(action).toBeVisible();
      expect((await action.boundingBox()).width).toBeGreaterThan(30);
    }
  });
}
