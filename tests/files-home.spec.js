const { test, expect } = require('@playwright/test');
const { APP, installBackend, nav } = require('./helpers');

test('Files resolves the remote home before listing and remembers navigation', async ({ page }) => {
  await installBackend(page);
  await page.addInitScript(() => {
    const invoke = window.__TAURI__.core.invoke;
    window.__TAURI__.core.invoke = async (cmd, args) => {
      if (cmd === 'files_home') { window.__calls.push({ cmd, args }); return '/home/test-user'; }
      if (cmd === 'files_list' && args.path === '/home/test-user') { window.__calls.push({ cmd, args }); return []; }
      return invoke(cmd, args);
    };
  });
  await page.goto(APP); await nav(page, 'Files');
  await expect(page.locator('#files-path')).toHaveValue('/home/test-user');
  const calls = await page.evaluate(() => window.__calls.filter(c => c.cmd.startsWith('files_')));
  expect(calls.map(c => c.cmd)).toEqual(['files_home', 'files_list']);
  expect(calls[1].args.path).toBe('/home/test-user');
  await page.getByRole('button', { name: 'Root directory' }).click();
  await expect(page.locator('#files-path')).toHaveValue('/');
  await nav(page, 'Overview'); await nav(page, 'Files');
  await expect(page.locator('#files-path')).toHaveValue('/');
  expect(await page.evaluate(() => window.__calls.filter(c => c.cmd === 'files_home').length)).toBe(1);
});

test('home lookup failure stays visible and never falls back to root', async ({ page }) => {
  await installBackend(page);
  await page.addInitScript(() => {
    const invoke = window.__TAURI__.core.invoke;
    window.__TAURI__.core.invoke = async (cmd, args) => {
      if (cmd === 'files_home') throw { kind: 'permission_denied', message: 'Home lookup denied' };
      return invoke(cmd, args);
    };
  });
  await page.goto(APP); await nav(page, 'Files');
  await expect(page.locator('#files-error')).toHaveText('Home lookup denied');
  expect(await page.evaluate(() => window.__calls.some(c => c.cmd === 'files_list'))).toBe(false);
});

test('file mutations wait until the home directory has resolved', async ({ page }) => {
  await installBackend(page);
  await page.addInitScript(() => {
    const invoke = window.__TAURI__.core.invoke;
    window.__TAURI__.core.invoke = (cmd, args) => cmd === 'files_home'
      ? new Promise(resolve => { window.resolveHome = () => resolve('/'); })
      : invoke(cmd, args);
  });
  await page.goto(APP); await nav(page, 'Files');
  await expect(page.getByRole('button', { name: 'New file', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeDisabled();
  await page.evaluate(() => window.resolveHome());
  await expect(page.getByRole('button', { name: 'New file', exact: true })).toBeEnabled();
});
