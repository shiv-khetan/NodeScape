// End-to-end flows in the test-only fake desktop backend.
const { test, expect } = require('@playwright/test');
const { openDemo, nav, clickService } = require('./helpers');

test.beforeEach(async ({ page }) => openDemo(page));

test('overview shows every card', async ({ page }) => {
  for (const title of ['CPU', 'Load', 'Memory', 'CPU history', 'Network in', 'Network out', 'Services', 'Recent journal']) {
    await expect(page.locator('.card h2', { hasText: new RegExp(`^${title}$`) })).toBeVisible();
  }
  await expect(page.locator('.page-meta')).toContainText('nas-01');
  await expect(page.locator('.step svg')).toBeVisible();
  await expect(page.locator('.dots').first()).toBeVisible();
});

test('every page renders', async ({ page }) => {
  for (const [name, title] of [['Services', 'Services'], ['Processes', 'Processes'], ['Logs', 'Logs'], ['Scheduled', 'Scheduled'], ['Overview', 'Overview']]) {
    await nav(page, name);
    await expect(page.locator('.hero h1')).toHaveText(title);
    await expect(page.locator('#nav button.on')).toHaveText(name);
  }
});

test('switching pages quickly never leaves a blank page', async ({ page }) => {
  await nav(page, 'Services');
  await nav(page, 'Logs');
  await nav(page, 'Processes');
  await expect(page.locator('.hero h1')).toHaveText('Processes');
  await expect(page.locator('tbody tr').first()).toBeVisible();
});

test('services search and state tabs filter rows', async ({ page }) => {
  await nav(page, 'Services');
  const visible = page.locator('tbody tr:visible');
  await expect(visible).toHaveCount(16);
  await page.locator('#filter').fill('jelly');
  await expect(visible).toHaveCount(1);
  await page.locator('#filter').fill('');
  await page.locator('[data-state="failed"]').click();
  await expect(visible).toHaveCount(2);
  await page.locator('[data-state="inactive"]').click();
  await expect(visible).toHaveCount(3);
});

test('start and stop change the service state', async ({ page }) => {
  await nav(page, 'Services');
  const row = page.locator('tr', { hasText: 'backup.service' });
  await clickService(page,'start','backup.service');
  await expect(page.locator('#toast')).toHaveText('Started backup.service on nas-01');
  await expect(row.locator('.tag')).toHaveText('running');

  await clickService(page,'stop','backup.service');
  await expect(row.locator('.tag')).toHaveText('dead');
});

test('a service "logs" button opens its logs', async ({ page }) => {
  await nav(page, 'Services');
  await page.locator('tr', { hasText: 'jellyfin.service' }).getByRole('button', { name: /More actions/ }).click();
  await page.locator('tr', { hasText: 'jellyfin.service' }).getByRole('button', { name: 'Logs', exact:true }).click();
  await expect(page.locator('.hero h1')).toHaveText('Logs');
  await expect(page.locator('#logunit')).toHaveValue('jellyfin.service');
  await expect(page.locator('.logrow').first()).toContainText('jellyfin');
});

test('scheduled page shows timers and every cron line, including @reboot', async ({ page }) => {
  await nav(page, 'Scheduled');
  await expect(page.locator('tbody tr')).toHaveCount(5);
  await expect(page.locator('.loglist .logrow')).toHaveCount(3);
  await expect(page.locator('.loglist')).toContainText('@reboot');
});

test('log line count can be changed', async ({ page }) => {
  await nav(page, 'Logs');
  await page.locator('[data-lines="100"]').click();
  await expect(page.locator('.logrow')).toHaveCount(100);
});

test('live refresh can be paused', async ({ page }) => {
  await page.locator('[data-act="live"]').click();
  await expect(page.locator('[data-act="live"]')).toHaveText('Resume live updates');
});
