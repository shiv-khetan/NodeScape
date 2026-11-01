// Connecting with host, port, user and key or password; asking for the password when needed; saying why a
// connection failed; and telling the user up front what admin (sudo) actions will need.
const { test, expect } = require('@playwright/test');
const { APP, installBackend, openServer, nav } = require('./helpers');
const F = require('./fixtures');

const calls = (page, cmd) => page.evaluate(cmd => window.__calls.filter(c => c.cmd === cmd), cmd);
async function newServer(page, responses = {}) {
  await installBackend(page, { host: null, profiles: [], responses }); await page.goto(APP);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'New server', exact: true }).click();
  await page.getByLabel('Server name').fill('Workshop'); await page.getByLabel('Alias', { exact: true }).fill('workshop');
  await page.getByLabel('Hostname or IP address').fill('192.0.2.10'); await page.getByLabel('SSH user').fill('operator');
  await page.getByLabel('Port').fill('2222');
}

test('new server form offers key or password login and an optional jump host', async ({ page }) => {
  await newServer(page);
  const auth = page.getByRole('group', { name: 'Authentication' });
  await expect(auth.getByRole('button', { name: 'SSH key' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Identity file', { exact: true })).toBeVisible();
  await auth.getByRole('button', { name: 'Password' }).click();
  await expect(page.getByLabel('Identity file', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-details]')).toContainText('You type the password when you connect');
  await page.getByText('Advanced').click();
  await page.getByLabel('Jump host').fill('admin@bastion.example');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const [save] = await calls(page, 'ssh_config_save');
  expect(save.args.server).toMatchObject({ alias: 'workshop', hostname: '192.0.2.10', user: 'operator', port: 2222, auth: 'password', identityFile: null, jump: 'admin@bastion.example' });
});

test('password servers ask for the password before testing and can save it encrypted', async ({ page }) => {
  await newServer(page);
  await page.getByRole('group', { name: 'Authentication' }).getByRole('button', { name: 'Password' }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Skip key installation' }).click();
  const password = page.getByLabel('Password for operator@192.0.2.10');
  await expect(password).toHaveAttribute('type', 'password');
  const remember = page.getByLabel(/Remember on this computer/);
  await expect(remember).toBeChecked();
  await expect(page.locator('[data-details], .setup-card')).toContainText('Windows Credential Manager');
  await password.fill('hunter2 secret');
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save server' })).toBeEnabled();
  const [set] = await calls(page, 'login_password_set');
  expect(set.args.login).toMatchObject({ target: { host: 'workshop' }, password: '[redacted]', remember: true });
  const order = await page.evaluate(() => window.__calls.map(c => c.cmd).filter(c => ['login_password_set', 'connection_test'].includes(c)));
  expect(order).toEqual(['login_password_set', 'connection_test']);
  await expect(password).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.outerHTML.includes('hunter2') || JSON.stringify(localStorage).includes('hunter2'))).toBe(false);
});

test('a failed connection test says why and shows the ssh log on request', async ({ page }) => {
  await installBackend(page, { host: null, profiles: [], responses: {
    connection_test: { error: { kind: 'unreachable', message: 'ssh: connect to host box port 22: Connection refused' } },
    connection_diagnose: { ok: false, error: { kind: 'unreachable', message: 'ssh: connect to host box port 22: Connection refused' }, log: 'debug1: Connecting to box [192.0.2.10] port 22.\ndebug1: connect to address 192.0.2.10 port 22: Connection refused' },
  } }); await page.goto(APP);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Server name').fill('Lab');
  await page.getByRole('button', { name: 'Choose config' }).click();
  await page.getByLabel('SSH alias').selectOption('testbox');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Skip key installation' }).click();
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(page.locator('[data-test-status]')).toContainText('Check the network or Tailscale connection');
  await page.getByRole('button', { name: 'Show details' }).click();
  const log = page.locator('.ssh-log');
  await expect(log).toContainText('debug1: connect to address 192.0.2.10 port 22: Connection refused');
  expect((await calls(page, 'connection_diagnose'))[0].args.target.host).toBe('testbox');
});

test('a page that needs a password asks in a dialog, then loads', async ({ page }) => {
  await openServer(page, { snapshot: [{ error: { kind: 'password_required', message: 'operator@testbox: Permission denied (publickey,password).' } }, F.SNAPSHOT] });
  const dialog = page.getByRole('dialog', { name: 'Connect to testbox' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password').fill('right one');
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.hero h1')).toHaveText('Overview');
  await expect(page.locator('.stats')).toBeVisible();
  expect((await calls(page, 'login_password_set'))[0].args.login).toMatchObject({ target: { host: 'testbox' }, password: '[redacted]', remember: true });
});

test('a refused password keeps the dialog open with a clear message; cancel shows the error page', async ({ page }) => {
  await openServer(page, { snapshot: [
    { error: { kind: 'password_required', message: 'Permission denied (publickey,password).' } },
    { error: { kind: 'password_refused', message: 'Permission denied (publickey,password).' } },
  ] });
  const dialog = page.getByRole('dialog', { name: 'Connect to testbox' });
  await dialog.getByLabel('Password').fill('wrong one');
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await expect(dialog).toContainText('That password was refused');
  await expect(dialog.getByLabel('Password')).toHaveValue('');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.unreachable')).toContainText('password');
  await expect(page.getByRole('button', { name: 'Enter password' })).toBeVisible();
});

test('the unreachable page offers connection details from ssh -v', async ({ page }) => {
  await openServer(page, {
    snapshot: { error: { kind: 'connection_closed', message: 'kex_exchange_identification: Connection closed by remote host' } },
    connection_diagnose: { ok: false, error: { kind: 'connection_closed', message: 'Connection closed by remote host' }, log: 'debug1: Connecting to testbox [10.0.0.2] port 22.\ndebug1: Connection established.\nkex_exchange_identification: Connection closed by remote host' },
  });
  await expect(page.locator('.unreachable')).toContainText('closed the connection');
  await page.getByRole('button', { name: 'Show details' }).click();
  await expect(page.locator('.ssh-log')).toContainText('debug1: Connection established.');
});

for (const [status, note, row] of [
  ['password', 'Admin actions ask for your sudo password', 'Yes'],
  ['passwordless', 'Admin actions run with passwordless sudo', 'No, passwordless sudo'],
  ['none', 'This account isn’t in a sudo group', 'Not available for this account'],
]) test('admin note and confirm row for sudo status ' + status, async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT, sudo_status: status });
  await nav(page, 'Services');
  await expect(page.locator('.admin-note')).toContainText(note);
  await page.locator('tbody tr').first().locator('[data-svc="restart"]').click();
  await expect(page.locator('.confirm-context')).toContainText('Requires administrator password' + row);
  await page.locator('.confirm-dialog [data-cancel]').click();
  await nav(page, 'Users');
  await expect(page.locator('.admin-note')).toContainText(note);
});
