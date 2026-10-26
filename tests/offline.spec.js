// The installed app must look identical offline: everything, including the font, ships with it.
const { test, expect } = require('@playwright/test');
const { APP } = require('./helpers');

test('loads nothing from the internet', async ({ page }) => {
  const external = [];
  page.on('request', r => /^https?:/.test(r.url()) && external.push(r.url()));
  await page.goto(APP);
  await expect(page.locator('.hero h1')).toHaveText('Overview');
  await page.evaluate(() => document.fonts.ready);
  expect(external).toEqual([]);
});

test('renders with the bundled Inter font', async ({ page }) => {
  await page.route(/^https?:/, r => r.abort()); // simulate being offline
  await page.goto(APP);
  await expect(page.locator('.hero h1')).toHaveText('Overview');
  await page.evaluate(() => document.fonts.ready);
  const inter = await page.evaluate(() => [...document.fonts].filter(f => f.family.replace(/"/g, '') === 'Inter').map(f => f.status));
  expect(inter.length).toBeGreaterThan(0);
  expect(inter).toContain('loaded');
});
