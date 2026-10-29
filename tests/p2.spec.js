// Overview without duplicate CPU/load cards, an error page that keeps its page context,
// and Logs that work from recognition: unit suggestions, day separators, message search.
const { test, expect } = require('@playwright/test');
const { openDemo, openServer, nav } = require('./helpers');
const F = require('./fixtures');

const card = (page, title) => page.locator('.overview-grid > .card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

test('Overview has one CPU card with load against cores, and no separate Load or CPU history card', async ({ page }) => {
  await openDemo(page);
  await expect(card(page, 'Load')).toHaveCount(0);
  await expect(card(page, 'CPU history')).toHaveCount(0);
  await expect(page.locator('.gauge, .bars')).toHaveCount(0);
  const cpu = card(page, 'CPU');
  await expect(cpu.locator('.step svg')).toBeVisible();
  await expect(cpu.locator('.stats')).toContainText('Load 1m');
});

test('Overview drill-downs come before network, system details sit in one strip', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDemo(page);
  const order = await page.locator('.overview-grid > *').evaluateAll(cards => cards.map(c => c.querySelector('h2')?.textContent || c.className));
  expect(order.indexOf('Recent journal')).toBeLessThan(order.indexOf('Network in'));
  expect(order.indexOf('Services')).toBeLessThan(order.indexOf('Network in'));
  const strip = page.locator('.overview-grid .system-strip');
  await expect(strip).toContainText(/Up 13d 9h/);
  await expect(strip).toContainText('kernel');
  // Cards sharing a row line up: no row has a card much shorter than its neighbours.
  const gaps = await page.locator('.overview-grid > .card').evaluateAll(cards => {
    const rows = {};
    for (const c of cards) { const r = c.getBoundingClientRect(); (rows[Math.round(r.top)] ||= []).push(r.height); }
    return Object.values(rows).map(h => Math.max(...h) - Math.min(...h));
  });
  expect(Math.max(...gaps)).toBeLessThan(2);
});

test('unreachable server keeps the page header and sidebar context', async ({ page }) => {
  await openServer(page, { snapshot: { error: { kind: 'unreachable', message: 'ssh: connect to host 10.0.0.2 port 22: No route to host' } } });
  await expect(page.locator('.hero h1')).toHaveText('Overview');
  await expect(page.locator('.page-meta')).toHaveText('testbox · unreachable');
  await expect(page.locator('#nav [aria-current]')).toHaveAttribute('data-view', 'overview');
  const alert = page.locator('.unreachable');
  await expect(alert).toHaveAttribute('role', 'alert');
  await expect(alert.getByRole('heading')).toHaveText("Can’t reach testbox");
  await expect(alert).toContainText('No route to host');
  await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
});

const TWO_DAYS = [
  '2026-01-01T23:58:00+00:00 testbox sshd[42]: Accepted publickey for admin',
  '2026-01-01T23:59:00+00:00 testbox backup[77]: error: repository unreachable',
  '2026-01-02T00:01:00+00:00 testbox cron[12]: Job started',
  '2026-01-02T00:02:00+00:00 testbox nginx[50]: reload complete',
].join('\n');

test('logs show a separator when the day changes', async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT, logs: TWO_DAYS });
  await nav(page, 'Logs');
  const days = page.locator('.logday');
  await expect(days).toHaveText(['Thu 1 Jan 2026', 'Fri 2 Jan 2026']);
  await expect(page.locator('.logrow')).toHaveCount(4);
});

test('logs message search filters rows and hides empty days', async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT, logs: TWO_DAYS });
  await nav(page, 'Logs');
  await page.getByRole('searchbox', { name: 'Search messages' }).fill('reload');
  await expect(page.locator('.logrow:visible')).toHaveCount(1);
  await expect(page.locator('.logrow:visible')).toContainText('reload complete');
  await expect(page.locator('.logday:visible')).toHaveText(['Fri 2 Jan 2026']);
  // Combined with the errors filter.
  await page.getByRole('searchbox', { name: 'Search messages' }).fill('');
  await page.locator('[data-logstate="errors"]').click();
  await expect(page.locator('.logrow:visible')).toHaveCount(1);
  await expect(page.locator('.logday:visible')).toHaveText(['Thu 1 Jan 2026']);
});

test('logs unit filter suggests known units', async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT, logs: TWO_DAYS });
  await expect(page.locator('.hero h1')).toHaveText('Overview');
  await nav(page, 'Logs');
  const input = page.locator('#logunit');
  await expect(input).toHaveAttribute('list', 'logunits');
  await expect(input).toHaveAttribute('placeholder', 'Filter by unit…');
  const options = await page.locator('#logunits option').evaluateAll(o => o.map(x => x.value));
  expect(options).toContain('nginx.service');
  expect(options).toContain('cron');
  expect(new Set(options).size).toBe(options.length);
});
