const { test, expect } = require('@playwright/test');
const { openServer, nav } = require('./helpers');
const F = require('./fixtures');

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
const required = { error: { kind: 'sudo_required', message: 'sudo: a password is required' } };
const wrong = { error: { kind: 'sudo_wrong_password', message: 'Sorry, try again.' } };
const secret = "synthetic-sudo-'$<secret>";
const calls = page => page.evaluate(() => window.__calls.filter(c => c.cmd === 'service_action'));
const dialog = page => page.getByRole('dialog', { name: 'Administrator permission' });
const password = page => dialog(page).getByLabel('Sudo password');

async function open(page, actions = ['ok']) {
  await openServer(page, { snapshot: F.SNAPSHOT, service_action: actions });
  await nav(page, 'Services');
  await expect(page.locator('.hero h1')).toHaveText('Services');
}
async function start(page) {
  await page.locator('[data-svc="start"]').first().click();
}
async function clean(page) {
  await expect(page.locator('.sudo-dialog')).toHaveCount(0);
  expect(await page.evaluate(value => ({
    html: document.documentElement.outerHTML.includes(value),
    inputs: [...document.querySelectorAll('input')].some(i => i.value.includes(value)),
    stored: JSON.stringify(localStorage).includes(value),
  }), secret)).toEqual({ html: false, inputs: false, stored: false });
}

test('start stop and restart succeed without a password dialog', async ({ page }) => {
  await open(page, ['ok', 'ok', 'ok']);
  for (const action of ['start', 'stop', 'restart']) {
    if (action !== 'start') page.once('dialog', d => d.accept());
    await page.locator('[data-svc="' + action + '"]').first().click();
    await expect(page.locator('#toast')).toContainText(action + ' nginx.service: ok');
  }
  expect((await calls(page)).map(c => c.args.password)).toEqual([null, null, null]);
  await clean(page);
});

test('password is used once and cleared immediately while the retry is pending', async ({ page }) => {
  await open(page, [required, { defer: true, value: 'ok' }]);
  await start(page);
  await expect(dialog(page)).toContainText('used once');
  await expect(dialog(page)).toContainText('never stored');
  await expect(password(page)).toHaveAttribute('type', 'password');
  await expect(password(page)).toHaveAttribute('autocomplete', 'off');
  await expect(password(page)).toBeFocused();
  await password(page).fill(secret);
  await password(page).evaluate(el => { window.__submittedSudoField = el; });
  await dialog(page).getByRole('button', { name: 'Run action' }).click();
  await expect.poll(() => page.evaluate(() => window.__pending.length)).toBe(1);
  expect(await page.evaluate(() => window.__submittedSudoField.value)).toBe('');
  await clean(page);
  await page.evaluate(() => window.__pending.shift()());
  await expect(page.locator('#toast')).toContainText('nginx.service: ok');
  expect((await calls(page)).map(c => c.args.password)).toEqual([null, '[redacted]']);
  await clean(page);
});

test('wrong password re-prompts with a blank focused field and a safe error', async ({ page }) => {
  await open(page, [required, wrong, wrong, 'ok']);
  await start(page);
  for (let i = 0; i < 2; i++) {
    await password(page).fill(secret);
    await dialog(page).getByRole('button', { name: 'Run action' }).click();
    await expect(dialog(page).getByRole('alert')).toHaveText('Incorrect password. Try again.');
    await expect(password(page)).toHaveValue('');
    await expect(password(page)).toBeFocused();
  }
  await password(page).fill(secret);
  await password(page).press('Enter');
  await expect(page.locator('#toast')).toContainText('nginx.service: ok');
  expect(await calls(page)).toHaveLength(4);
  await clean(page);
});

for (const method of ['Cancel', 'Escape']) {
  test(method + ' rejects with cancelled and clears the password without retrying', async ({ page }) => {
    await open(page, [required]);
    await page.evaluate(() => {
      window.__sudoResult = null;
      import('/ui/sudo.js').then(({ withSudo }) => withSudo(async () => { throw { kind: 'sudo_required' }; }))
        .catch(error => { window.__sudoResult = error; });
    });
    await password(page).fill(secret);
    await password(page).evaluate(el => { window.__submittedSudoField = el; });
    if (method === 'Cancel') await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    else await password(page).press('Escape');
    await expect.poll(() => page.evaluate(() => window.__sudoResult?.kind)).toBe('cancelled');
    expect(await page.evaluate(() => window.__submittedSudoField.value)).toBe('');
    expect(await calls(page)).toHaveLength(0);
    await clean(page);
  });
}

test('cancelling a service password dialog makes no second service call', async ({ page }) => {
  await open(page, [required]);
  await start(page);
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await clean(page);
  expect(await calls(page)).toHaveLength(1);
});

test('a later action starts without a cached password', async ({ page }) => {
  await open(page, [required, 'ok', required, 'ok']);
  for (let i = 0; i < 2; i++) {
    await start(page);
    await expect(password(page)).toHaveValue('');
    await password(page).fill(secret);
    await password(page).press('Enter');
    await expect(page.locator('#toast')).toContainText('nginx.service: ok');
    await clean(page);
  }
  expect((await calls(page)).map(c => c.args.password)).toEqual([null, '[redacted]', null, '[redacted]']);
});

test('permission errors are shown as text without prompting or retrying', async ({ page }) => {
  await open(page, [{ error: { kind: 'permission_denied', message: '<img src=x onerror=alert(1)> denied' } }]);
  await start(page);
  await expect(page.locator('#toast')).toHaveText('<img src=x onerror=alert(1)> denied');
  await expect(page.locator('#toast img')).toHaveCount(0);
  expect(await calls(page)).toHaveLength(1);
  await clean(page);
});

test('a non-password failure after submission is never retried', async ({ page }) => {
  await open(page, [required, { error: { kind: 'timeout', message: 'SSH operation timed out' } }]);
  await start(page);
  await password(page).fill(secret);
  await password(page).press('Enter');
  await expect(page.locator('#toast')).toHaveText('SSH operation timed out');
  expect(await calls(page)).toHaveLength(2);
  await clean(page);
});

test('a changed target cancels the pending password retry', async ({ page }) => {
  await open(page, [required, 'ok']);
  await start(page);
  await page.evaluate(async () => { const { selectTarget } = await import('/state.js'); selectTarget('other-testbox'); });
  await password(page).fill(secret);
  await password(page).press('Enter');
  await clean(page);
  expect(await calls(page)).toHaveLength(1);
});

for (const [width, height] of [[800, 600], [2560, 1440]]) {
  test('password dialog fits ' + width + 'x' + height, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await open(page, [required]);
    await start(page);
    const fits = await dialog(page).evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && el.scrollWidth <= el.clientWidth;
    });
    expect(fits).toBe(true);
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  });
}
