// Red means "something is wrong", and every page is reachable from the keyboard.
const { test, expect } = require('@playwright/test');
const { openDemo, nav } = require('./helpers');

const color = loc => loc.evaluate(e => getComputedStyle(e).color);

test('Stop links are neutral text; red stays for failures', async ({ page }) => {
  await openDemo(page);
  await nav(page, 'Services');
  const stop = page.locator('[data-svc="stop"]:visible').first();
  const link = page.locator('[data-svc="restart"]:visible').first();
  await expect(stop).toBeVisible();
  expect(await color(stop)).toBe(await color(link));
  await nav(page, 'Overview');
  await page.getByRole('button', { name: 'Manage servers', exact: true }).click();
  const remove = page.getByRole('button', { name: 'Remove', exact: true }).first();
  expect(await color(remove)).toBe(await color(page.getByRole('button', { name: 'Edit', exact: true }).first()));
});

test('Ctrl+number opens pages, Ctrl+R refreshes, / focuses search', async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press('Control+2');
  await expect(page.locator('.hero h1')).toHaveText('Services');
  await expect(page.locator('#nav [aria-current]')).toHaveAttribute('aria-keyshortcuts', 'Control+2');
  await page.keyboard.press('/');
  await expect(page.locator('.page-toolbar input[type=search]')).toBeFocused();
  // Typing "/" into a field types it, it does not jump.
  await page.keyboard.type('a/b');
  await expect(page.locator('.page-toolbar input[type=search]')).toHaveValue('a/b');
  await page.keyboard.press('Escape');
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  const before = await page.evaluate(() => window.__calls.length);
  await page.keyboard.press('Control+r');
  await expect.poll(() => page.evaluate(() => window.__calls.length)).toBeGreaterThan(before);
  await expect(page.locator('.hero h1')).toHaveText('Services'); // no page reload
  await page.keyboard.press('Control+9');
  await expect(page.locator('.hero h1')).toHaveText('Users');
});

test('Ctrl+K palette filters commands and runs one from the keyboard', async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Commands' });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('combobox')).toBeFocused();
  await page.keyboard.type('logs');
  await expect(palette.getByRole('option').first()).toContainText('Logs');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page.locator('.hero h1')).toHaveText('Logs');
  // Arrow keys move the active option; Escape closes and returns focus.
  await page.locator('#paletteBtn').click();
  await expect(palette).toBeVisible();
  await page.keyboard.type('go to');
  const first = await palette.getByRole('option').first().textContent();
  await page.keyboard.press('ArrowDown');
  await expect(palette.getByRole('option', { selected: true })).not.toHaveText(first);
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await expect(page.locator('#paletteBtn')).toBeFocused();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('zzzz');
  await expect(palette).toContainText('No matching commands');
});

test('palette switches server', async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('switch to testbox');
  await page.keyboard.press('Enter');
  await expect(page.locator('#host option:checked')).toHaveText('testbox');
});

test('arrow keys move between table rows, keeping the column', async ({ page }) => {
  await openDemo(page);
  await nav(page, 'Services');
  const rows = page.locator('tbody tr');
  await rows.nth(2).locator('[data-svc="restart"]').focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(3).locator('[data-svc="restart"]')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(rows.nth(1).locator('[data-svc="restart"]')).toBeFocused();
});
