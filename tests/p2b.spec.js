// Critique round 4 P2s: narrow sidebar context, one CPU percentage, stale data when unreachable, one pattern per job.
const { test, expect } = require('@playwright/test');
const { openDemo, openServer, nav } = require('./helpers');
const F = require('./fixtures');

const iconPath = loc => loc.locator('svg').first().innerHTML();

test('narrow sidebar shows which server is selected, and server actions have distinct icons', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openDemo(page);
  const mono = page.locator('.hostbox .host-mono');
  await expect(mono).toBeVisible();
  await expect(mono).toHaveText('N1');
  await expect(page.locator('.hostbox')).toHaveAttribute('title', 'Server: nas-01');
  expect(await iconPath(page.locator('#manageServers'))).not.toBe(await iconPath(page.locator('.hostbox')));
  await page.selectOption('#host', 'testbox');
  await expect(mono).toHaveText('TE');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(mono).toBeHidden();
});

test('Overview CPU card has one headline percentage and value chips are plain text', async ({ page }) => {
  await openDemo(page);
  const top = page.locator('.cpu .card-top');
  await expect(top).not.toContainText('load');
  for (const chip of await page.locator('.overview-grid .tip, .overview-grid .badge').all()) {
    await expect(chip).toHaveCSS('border-top-width', '0px');
  }
});

test('Overview services card lists healthy units only, failures stay in the problems band', async ({ page }) => {
  await openDemo(page);
  const services = page.locator('.services-card');
  await expect(services.locator('.status.bad, .status.failed, .tag.failed')).toHaveCount(0);
  await expect(services).not.toContainText('failed');
  await expect(services.locator('.card-top')).toContainText('11 running');
  await expect(services).toContainText(/\+\d+ more running/);
});

test('a page that becomes unreachable keeps its last data, dimmed, with when it was last reached and Retry', async ({ page }) => {
  await openDemo(page);
  await nav(page, 'Services');
  await expect(page.locator('tbody tr')).toHaveCount(16);
  await page.evaluate(() => {
    const old = window.__TAURI__.core.invoke;
    window.__failedReads = 0;
    window.__TAURI__.core.invoke = (cmd, args) => cmd === 'services_read' ? (window.__failedReads++, Promise.reject({ kind: 'unreachable', message: 'No route to host' })) : old(cmd, args);
  });
  await page.locator('#refresh').click();
  const band = page.locator('.action-alert');
  await expect(band).toContainText('No route to host');
  await expect(band).toContainText(/Last reached \d+s ago/);
  await expect(page.locator('tbody tr')).toHaveCount(16);
  await expect(page.locator('.page-head ~ .grid')).toHaveClass(/stale/);
  expect(await page.locator('.page-head ~ .grid').evaluate(el => el.inert)).toBe(true);
  await expect(page.locator('.page-meta')).toContainText('unreachable');
  await band.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => page.evaluate(() => window.__failedReads)).toBe(2);
  await expect(page.locator('tbody tr')).toHaveCount(16); // still showing the last data after a second failure
});

test('onboarding steps read as a numbered progress line, not tabs', async ({ page }) => {
  const { installBackend, APP } = require('./helpers');
  await installBackend(page, { host: null, profiles: [] }); await page.goto(APP);
  const steps = page.locator('.setup-steps li');
  await expect(steps.first()).toHaveAttribute('aria-current', 'step');
  await expect(steps.first()).toHaveCSS('border-bottom-width', '0px');
  expect(await steps.first().evaluate(el => getComputedStyle(el, '::before').content)).toMatch(/counter\(step\)/);
});

test('network: default route is a tag, not a tint; status words are lower case', async ({ page }) => {
  await openDemo(page);
  await nav(page, 'Network');
  await expect(page.locator('.network-default')).toHaveCount(0);
  await expect(page.locator('td .tag', { hasText: 'default' }).first()).toBeVisible();
  const words = await page.locator('.interface-row .tag, tr[data-protocol] td:nth-child(2), .network-table .state').allTextContents();
  expect(words.length).toBeGreaterThan(0);
  for (const w of words) expect(w).toBe(w.toLowerCase());
  await expect(page.locator('main')).not.toContainText('UNCONN');
  await expect(page.locator('tr[data-protocol="udp"]')).toContainText('unconnected');
});

test('scheduled: crontab is a table with headers, timer units are plain links', async ({ page }) => {
  await openDemo(page);
  await nav(page, 'Scheduled');
  const cron = page.locator('article', { has: page.getByRole('heading', { name: 'Crontab' }) });
  await expect(cron.locator('thead th')).toHaveText(['Schedule', 'Command']);
  await expect(page.locator('[data-unit].pill')).toHaveCount(0);
});

test('page-wide create actions sit in the header, filters in the toolbar', async ({ page }) => {
  await openDemo(page);
  await nav(page, 'Files');
  await expect(page.locator('.header-actions [data-file-action="mkdir"]')).toBeVisible();
  await expect(page.locator('.header-actions [data-file-action="create"]')).toBeVisible();
  await nav(page, 'Logs');
  await expect(page.locator('.page-toolbar [data-lines]')).toHaveCount(3);
  await expect(page.locator('.header-actions [data-lines]')).toHaveCount(0);
});

test('/ on Logs focuses the message search', async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT, logs: F.LOGS_LIMITED });
  await nav(page, 'Logs');
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  await expect(page.locator('#logsearch')).toBeFocused();
});
