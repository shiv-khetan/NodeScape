// On a Mac the app shows ⌘ shortcuts and names the keychain, not Windows Credential Manager.
const { test, expect } = require('@playwright/test');
const { openDemo } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }));
});

test('Mac shows ⌘ shortcuts, accepts Cmd keys and names the keychain', async ({ page }) => {
  await openDemo(page);
  await expect(page.locator('#paletteBtn')).toHaveAttribute('title', 'Commands (⌘K)');
  await expect(page.locator('#paletteBtn')).toHaveAttribute('aria-keyshortcuts', 'Meta+K');
  await expect(page.locator('#nav button').nth(1)).toHaveAttribute('aria-keyshortcuts', 'Meta+2');
  await page.keyboard.press('Meta+2');
  await expect(page.locator('.hero h1')).toHaveText('Services');
  await page.keyboard.press('Meta+k');
  const palette = page.getByRole('dialog', { name: 'Commands' });
  await expect(palette.getByRole('option', { name: /Refresh/ })).toContainText('⌘R');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+1');
  await page.getByRole('button', { name: 'Manage servers', exact: true }).click();
  await expect(page.locator('main')).toContainText('macOS keychain');
  await expect(page.locator('main')).not.toContainText('Windows');
});
