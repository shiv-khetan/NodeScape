const { test, expect } = require('./fixtures');
test.skip(process.platform !== 'win32', 'Real app tests require Windows WebView2');
// Only read the configured host. No fixture backend, captures, sudo, or writes.
const nav = (page, name) => page.locator('#nav button', { hasText: name }).click();

test('seeded profile loads real Overview data and charts', async ({ hostApp: { page } }) => {
  await expect.poll(() => page.locator('.hero h1').textContent().then(text => text === 'Overview')).toBe(true);
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/state.js');
    return !!state.snap && Number.isFinite(state.snap.cpu) && state.snap.mem[0] > 0 && !!state.snap.host;
  })).toBe(true);
  await page.locator('#refresh').click();
  await expect(page.locator('.step svg')).toBeVisible();
});

test('Terminal connects and prints a marker through the real PTY', async ({ hostApp: { page } }) => {
  await nav(page, 'Terminal');
  await expect.poll(() => page.locator('[data-terminal-status]').textContent().then(text => text === 'Connected')).toBe(true);
  // Split the marker in the command: the complete marker must come from printf output, not local echo.
  await page.locator('.xterm-helper-textarea').pressSequentially("printf '%s%s\\n' NODESCAPE_ APP_PTY_OK");
  await page.locator('.xterm-helper-textarea').press('Enter');
  await expect.poll(() => page.locator('.xterm-rows').textContent().then(text => text.includes('NODESCAPE_APP_PTY_OK'))).toBe(true);
});

test('Files opens remote home and lists the configured test directory', async ({ hostApp: { page, settings } }) => {
  await nav(page, 'Files');
  await expect.poll(() => page.locator('#files-path').inputValue().then(Boolean)).toBe(true);
  const homeMatches = await page.evaluate(async () => {
    const { currentTarget } = await import('/state.js');
    try { return document.querySelector('#files-path').value === await window.__TAURI__.core.invoke('files_home', { target: currentTarget() }); } catch { return false; }
  });
  expect(homeMatches).toBe(true);
  await page.locator('#files-path').fill(settings.dir); await page.locator('#files-path').press('Enter');
  await expect.poll(() => page.evaluate(() => !document.querySelector('#files-entries').hasAttribute('aria-busy'))).toBe(true);
  expect(await page.locator('#files-error').isVisible()).toBe(false);
  expect(await page.locator('#files-path').inputValue() === settings.dir.replace(/\/+$/, '')).toBe(true);
  expect(await page.locator('.files-row, .files-empty').count()).toBeGreaterThan(0);
});

test('Network renders real read-only inspection', async ({ hostApp: { page } }) => {
  await nav(page, 'Network');
  await expect.poll(() => page.locator('.hero h1').textContent().then(text => text === 'Network')).toBe(true);
  await expect(page.locator('#network-interfaces')).toBeVisible();
  await expect(page.locator('#network-routes')).toBeVisible();
  await expect(page.locator('#network-ports')).toBeVisible();
});
