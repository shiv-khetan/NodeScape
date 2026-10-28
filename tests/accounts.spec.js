const { test, expect } = require('@playwright/test');
const { APP, installBackend, nav, openRowMenu } = require('./helpers');
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
const calls = page => page.evaluate(() => window.__calls.filter(c => c.cmd === 'account_action'));
const row = (page, name) => page.locator('#accounts-users tbody tr').filter({ has: page.getByText(name, { exact: true }) });
async function open(page, responses) {
  await installBackend(page, responses ? { responses } : {});
  await page.goto(APP);
  await nav(page, 'Users');
  await expect(page.locator('.hero h1')).toHaveText('Users');
}
async function add(page, name = 'newuser', groups = '') {
  await page.getByRole('button', { name: 'Add user', exact: true }).click();
  await page.getByLabel('User name', { exact: true }).fill(name);
  await page.getByLabel('Groups (optional)').fill(groups);
  await page.getByRole('button', { name: 'Create user', exact: true }).click();
}
async function group(page, action, name = 'alice', value = 'team') {
  if(action === 'Remove group') await openRowMenu(row(page,name));
  await row(page, name).getByRole('button', { name: action, exact: true }).click();
  await page.getByLabel('Group', { exact: true }).selectOption(value);
  await page.getByRole('dialog').getByRole('button', { name: action, exact: true }).click();
}
async function remove(page, home) {
  await openRowMenu(row(page,'alice'));
  await row(page, 'alice').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Keep the home directory unless');
  await expect(page.getByLabel('Also delete the home directory')).not.toBeChecked();
  await page.getByLabel('I confirm deleting this user').check();
  if (home) await page.getByLabel('Also delete the home directory').check();
  await page.getByRole('button', { name: 'Delete alice', exact: true }).click();
}

test('users, groups, stats and limited sudo scope', async ({ page }) => {
  await open(page);
  await expect(page.locator('#accounts-users tbody tr:visible')).toHaveCount(2);
  await expect(row(page, 'alice')).toContainText('sudo');
  await expect(page.locator('#accounts-groups')).toContainText('team');
  await expect(page.locator('.page-toolbar')).toContainText('Login users');
  await expect(page.getByText('Only group-based sudo is shown. Rules in sudoers are not read.', { exact: true })).toBeVisible();
  await expect(page.locator('#accounts-current')).toHaveText('SSH user: operator');
});

test('filter searches users and groups and system toggle starts off', async ({ page }) => {
  await open(page);
  await expect(page.getByLabel('Show system accounts')).not.toBeChecked();
  await page.getByLabel('Show system accounts').check();
  await expect(row(page, 'root')).toBeVisible();
  await expect(row(page, 'daemon')).toContainText('No login');
  await page.getByLabel('Filter users',{exact:true}).fill('sudo');
  await expect(page.locator('#accounts-users tbody tr:visible')).toHaveCount(1);
  await page.getByLabel('Filter users',{exact:true}).fill('ALICE');
  await expect(row(page, 'alice')).toBeVisible();
  await page.getByLabel('Filter users',{exact:true}).fill('no-match');
  await expect(page.getByText('No users match this filter.')).toBeVisible();
});

test('create user prompts for sudo, clears the secret and refreshes', async ({ page }) => {
  await open(page);
  await add(page, 'newuser', 'team, sudo');
  await expect(page.locator('.confirm-dialog')).toBeVisible();
  await page.getByLabel(/Administrator password for/).fill('synthetic-accounts-password');
  await page.locator('.confirm-dialog button[type="submit"]').click();
  await expect(row(page, 'newuser')).toBeVisible();
  expect((await calls(page)).map(c => c.args.password)).toEqual([null, '[redacted]']);
  expect((await calls(page))[1].args.args).toEqual({ name: 'newuser', groups: ['team', 'sudo'] });
  expect(await page.evaluate(() => document.documentElement.outerHTML.includes('synthetic-accounts-password') || JSON.stringify(localStorage).includes('synthetic-accounts-password'))).toBe(false);
});

test('cancel sudo never creates a user', async ({ page }) => {
  await open(page); await add(page);
  await page.locator('.confirm-dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row(page, 'newuser')).toHaveCount(0);
  expect(await calls(page)).toHaveLength(1);
});

test('invalid name is rejected before IPC', async ({ page }) => {
  await open(page); await add(page, 'bad;name');
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Invalid account name');
  expect(await calls(page)).toHaveLength(0);
});

for (const action of ['Add group', 'Remove group']) {
  test(action + ' uses the fixed action and refreshes membership', async ({ page }) => {
    await open(page);
    await group(page, action, 'alice', action === 'Add group' ? 'extra' : 'team');
    await page.getByLabel(/Administrator password for/).fill('synthetic');
    await page.locator('.confirm-dialog button[type="submit"]').click();
    await expect(page.locator('#toast')).toContainText('completed');
    if (action === 'Add group') await expect(row(page, 'alice')).toContainText('extra');
    else await expect(row(page, 'alice').locator('[data-group-tag="team"]')).toHaveCount(0);
    expect((await calls(page)).at(-1).args.action).toBe(action === 'Add group' ? 'add_to_group' : 'remove_from_group');
  });
}

for (const home of [false, true]) {
  test('delete user with removeHome=' + home, async ({ page }) => {
    await open(page); await remove(page, home);
    await page.getByLabel(/Administrator password for/).fill('synthetic');
    await page.locator('.confirm-dialog button[type="submit"]').click();
    await expect(row(page, 'alice')).toHaveCount(0);
    expect((await calls(page)).at(-1).args.args).toEqual({ name: 'alice', removeHome: home });
  });
}

test('deletion requires confirmation and cancelling leaves the account intact', async ({ page }) => {
  await open(page);
  await openRowMenu(row(page,'alice'));
  await row(page, 'alice').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Delete alice', exact: true })).toBeDisabled();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  expect(await calls(page)).toHaveLength(0);
  await expect(row(page, 'alice')).toBeVisible();
});

test('root current user and system accounts show refusal reasons', async ({ page }) => {
  await open(page); await page.getByLabel('Show system accounts').check();
  for (const name of ['root', 'operator', 'daemon', 'nobody']) {
    await openRowMenu(row(page,name));
    await expect(row(page, name).getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
    await expect(row(page, name).getByRole('button', { name: 'Remove group', exact: true })).toBeDisabled();
    await expect(row(page, name)).toContainText('Protected');
    await page.keyboard.press('Escape');
  }
});

test('duplicate name gets a clear refusal before a password prompt', async ({ page }) => {
  await open(page); await add(page, 'alice');
  await expect(page.locator('.action-alert')).toContainText('already exists');
  await expect(page.locator('.confirm-dialog')).toHaveCount(0);
});

test('remote errors are text and outcome unknown refreshes without retry', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.__accountsActionError = { kind: 'outcome_unknown', message: '<img src=x> disconnected' }; });
  const before = await page.evaluate(() => window.__calls.filter(c => c.cmd === 'accounts_read').length);
  await add(page);
  await expect(page.locator('.action-alert')).toContainText('disconnected');
  await expect(page.locator('.action-alert img')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__calls.filter(c => c.cmd === 'accounts_read').length)).toBeGreaterThan(before);
  expect(await calls(page)).toHaveLength(1);
});

test('backend refusal is displayed safely without retry', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.__accountsActionError = { kind: 'permission_denied', message: 'Refused: <script>protected</script>' }; });
  await add(page);
  await expect(page.locator('.action-alert')).toContainText('Refused: <script>protected</script>');
  await expect(page.locator('.action-alert script')).toHaveCount(0);
  expect(await calls(page)).toHaveLength(1);
});

test('untrusted names, groups, home and shell are escaped', async ({ page }) => {
  const evil = '<img src=x onerror=alert(1)>';
  await open(page, { accounts_read: { users: [{ name: evil, uid: 1000, gid: 1000, home: evil, shell: evil, groups: [evil], system: false, login: true }], groups: [{ name: evil, gid: 1000, members: [evil] }], currentUser: evil, sudoGroups: [evil] } });
  await expect(page.locator('#accounts-users')).toContainText(evil);
  await expect(page.locator('#accounts-groups')).toContainText(evil);
  await expect(page.locator('#main img')).toHaveCount(0);
});

test('switching target while sudo is open prevents the retry', async ({ page }) => {
  await open(page); await add(page);
  await page.getByLabel(/Administrator password for/).fill('synthetic');
  await page.evaluate(async () => { const { selectTarget } = await import('/state.js'); selectTarget('other-testbox'); });
  await page.locator('.confirm-dialog button[type="submit"]').click();
  await expect(page.locator('.confirm-dialog')).toHaveCount(0);
  expect(await calls(page)).toHaveLength(1);
});

test('a changed target while the add dialog is open prevents submission', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Add user', exact: true }).click();
  await page.getByLabel('User name', { exact: true }).fill('newuser');
  await page.evaluate(async () => { const { selectTarget } = await import('/state.js'); selectTarget('other-testbox'); });
  await page.getByRole('button', { name: 'Create user', exact: true }).click();
  expect(await calls(page)).toHaveLength(0);
});

for (const [width, height] of [[800, 600], [1024, 768], [1280, 800], [1440, 900], [1920, 1080], [2560, 1440]]) {
  test('accounts and dialogs fit ' + width + 'x' + height, async ({ page }) => {
    await page.setViewportSize({ width, height }); await open(page);
    await page.getByLabel('Show system accounts').check();
    expect(await page.evaluate(() => {
      const bad = [];
      if (document.documentElement.scrollWidth > innerWidth + 1) bad.push('page');
      for (const e of document.querySelectorAll('header, .hero, .card')) if (e.scrollWidth > e.clientWidth + 1) bad.push(e.className);
      return bad;
    })).toEqual([]);
    await page.getByRole('button', { name: 'Add user', exact: true }).click();
    expect(await page.getByRole('dialog').evaluate(e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && e.scrollWidth <= e.clientWidth; })).toBe(true);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    for (const action of ['Add group', 'Remove group', 'Delete']) {
      if(action !== 'Add group') await openRowMenu(row(page,'alice'));
      await row(page, 'alice').getByRole('button', { name: action, exact: true }).click();
      expect(await page.getByRole('dialog').evaluate(e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && e.scrollWidth <= e.clientWidth; })).toBe(true);
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    }
  });
}
