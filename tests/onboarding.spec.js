const { test, expect } = require('@playwright/test');
const { APP, installBackend, nav } = require('./helpers');
const calls = (page, cmd) => page.evaluate(cmd => window.__calls.filter(c => c.cmd === cmd), cmd);
async function first(page, responses = {}) {
  await installBackend(page, { host: null, profiles: [], responses }); await page.goto(APP);
  await expect(page.locator('.hero h1')).toHaveText('Add a server');
}
async function environment(page) { await page.getByRole('button', { name: 'Continue', exact: true }).click(); }
async function alias(page) {
  await environment(page); await page.getByLabel('Server name').fill('Lab');
  await page.getByRole('button', { name: 'Choose config' }).click();
  await page.getByLabel('SSH alias').selectOption('testbox');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Trust the host key' })).toBeVisible();
}
async function tested(page) {
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Skip key installation' }).click();
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
}
async function finish(page) { await tested(page); await expect(page.getByRole('button', { name: 'Save server' })).toBeEnabled(); await page.getByRole('button', { name: 'Save server' }).click(); }

test('first run checks the environment without remote queries', async ({ page }) => {
  await first(page); await expect(page.getByRole('heading', { name: 'Check your environment' })).toBeVisible();
  await expect(page.locator('[data-environment]')).toContainText('OpenSSH');
  expect(await calls(page, 'query')).toHaveLength(0); expect(await calls(page, 'environment_check')).toHaveLength(1);
});
test('existing alias path trusts, tests, and saves a profile', async ({ page }) => {
  await first(page); await alias(page); await finish(page);
  await expect(page.locator('#host')).toHaveValue('profile-1');
  const [saved] = await calls(page, 'profile_save'); expect(saved.args.profile).toMatchObject({ name: 'Lab', host: 'testbox', config: 'C:/synthetic/ssh config' });
  expect((await calls(page, 'terminal_open_kind'))[0].args.kind).toBe('trust_host');
  expect(await calls(page, 'connection_test')).toHaveLength(1);
});
test('new server path writes only the managed config and optionally installs its public key', async ({ page }) => {
  await first(page); await environment(page); await page.getByRole('button', { name: 'New server', exact: true }).click();
  await page.getByLabel('Server name').fill('Workshop'); await page.getByLabel('Alias', { exact: true }).fill('workshop');
  await page.getByLabel('Hostname').fill('box.example'); await page.getByLabel('SSH user').fill('operator');
  await page.getByLabel('Port').fill('2222'); await page.getByLabel('Identity file', { exact: true }).fill('C:/synthetic/key with spaces');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  expect((await calls(page, 'ssh_config_save'))[0].args.server.port).toBe(2222);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Public key file').fill('C:/synthetic/key with spaces.pub');
  await page.getByRole('button', { name: 'Install public key' }).click();
  await expect.poll(async () => (await calls(page, 'terminal_open_kind')).length).toBe(2);
  expect((await calls(page, 'terminal_open_kind'))[1].args).toMatchObject({ kind: 'install_key', args: { publicKey: 'ssh-ed25519 AAAA nodescape' } });
  await page.evaluate(() => window.__terminalExit('terminal-2'));
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Test connection', exact: true }).click(); await page.getByRole('button', { name: 'Save server' }).click();
  expect((await calls(page, 'profile_save'))[0].args.profile.config).toBe('C:/synthetic/app/ssh_config');
});
test('key generation uses a constrained terminal and waits for success', async ({ page }) => {
  await first(page); await environment(page); await page.getByRole('button', { name: 'New server', exact: true }).click();
  await page.getByLabel('Server name').fill('Lab'); await page.getByLabel('Alias', { exact: true }).fill('lab');
  await page.getByLabel('Hostname').fill('box.example'); await page.getByLabel('SSH user').fill('operator');
  await page.getByLabel('Identity file', { exact: true }).fill('C:/synthetic/new key');
  await page.getByRole('button', { name: 'Generate key' }).click();
  expect((await calls(page, 'terminal_open_kind'))[0].args).toMatchObject({ kind: 'keygen', args: { path: 'C:/synthetic/new key' } });
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await page.evaluate(() => window.__terminalExit('terminal-1')); await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
});
test('switching away from key generation closes it and leaves the alias path usable', async ({ page }) => {
  await first(page); await environment(page); await page.getByRole('button',{name:'New server',exact:true}).click();
  await page.getByLabel('Identity file',{exact:true}).fill('C:/synthetic/new key');
  await page.getByRole('button',{name:'Generate key',exact:true}).click();
  await page.getByRole('button',{name:'Existing SSH config',exact:true}).click();
  await expect(page.getByRole('button',{name:'Continue',exact:true})).toBeEnabled();
  await expect.poll(async()=>(await calls(page,'terminal_close')).length).toBe(1);
});
test('connection failure stays on the test step with a typed escaped error', async ({ page }) => {
  await first(page, { connection_test: { error: { kind: 'auth_failed', message: '<b>Key refused</b>' } } });
  await alias(page); await tested(page);
  await expect(page.locator('[data-onboarding-error]')).toHaveText('auth_failed: <b>Key refused</b>');
  await expect(page.locator('[data-onboarding-error] b')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Save server' })).toBeDisabled();
  expect(await calls(page, 'profile_save')).toHaveLength(0);
});
test('switcher changes target, clears filters, and closes setup terminals', async ({ page }) => {
  await installBackend(page, { profiles: [{ id: 'a', name: 'Alpha', host: 'testbox', config: null }, { id: 'b', name: 'Beta', host: 'nas-01', config: 'C:/synthetic/config' }] }); await page.goto(APP);
  await expect(page.locator('.hero h1')).toHaveText('Overview');
  await page.evaluate(async () => { const {state} = await import('/state.js'); state.logUnit='old.service'; state.svcFilter='old'; state.svcState='failed'; });
  await page.locator('#host').selectOption('b');
  await expect.poll(() => page.evaluate(async () => { const {state} = await import('/state.js'); return [state.host,state.config,state.logUnit,state.svcFilter,state.svcState]; })).toEqual(['nas-01','C:/synthetic/config','','','all']);
  await page.getByRole('button', { name: 'Add server', exact: true }).click(); await alias(page);
  await expect.poll(async () => (await calls(page, 'terminal_open_kind')).length).toBe(1);
  await page.locator('#host').selectOption('a'); await expect.poll(async () => (await calls(page, 'terminal_close')).length).toBe(1);
});
test('manage servers renames and edits profiles, and removal confirms', async ({ page }) => {
  await installBackend(page); await page.goto(APP); await page.getByRole('button', { name: 'Manage servers', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await page.getByLabel('Server name').fill('Renamed'); await page.getByLabel('SSH target').fill('operator@box.example');
  await page.getByRole('button', { name: 'Save changes' }).click(); await expect(page.locator('[data-server-row]').first()).toContainText('Renamed');
  await page.getByRole('button', { name: 'Remove', exact: true }).first().click(); await page.locator('.confirm-dialog [data-cancel]').click(); expect(await calls(page, 'profile_remove')).toHaveLength(0);
  await page.getByRole('button', { name: 'Remove', exact: true }).first().click(); await page.locator('.confirm-dialog button.danger').click(); await expect.poll(async()=> (await calls(page,'profile_remove')).length).toBe(1);
});
test('legacy target migrates once with its config; demo is ignored', async ({ page }) => {
  await installBackend(page, { host: 'legacy', profiles: [] }); await page.addInitScript(() => localStorage.setItem('sshConfig','C:/synthetic/legacy config')); await page.goto(APP);
  await expect.poll(async () => (await calls(page, 'profile_save')).length).toBe(1);
  expect((await calls(page, 'profile_save'))[0].args.profile).toMatchObject({ host:'legacy',config:'C:/synthetic/legacy config' });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('profilesMigrated'))).toBe('1');
  await page.reload(); expect(await calls(page,'profile_save')).toHaveLength(0);
});
test('stale demo is never migrated', async ({ page }) => {
  await installBackend(page, { host: 'demo', profiles: [] }); await page.goto(APP);
  await expect(page.locator('.hero h1')).toHaveText('Add a server'); expect(await calls(page,'profile_save')).toHaveLength(0);
});
for(const [width,height] of [[800,600],[1024,768],[1280,800],[1440,900],[1920,1080],[2560,1440]]) test('onboarding and management fit '+width+'x'+height, async ({page})=>{
  await page.setViewportSize({width,height}); await first(page); await environment(page);
  await page.getByRole('button',{name:'New server',exact:true}).click();
  const fits=()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1 && [...document.querySelectorAll('header,.hero,.card')].every(e=>e.scrollWidth<=e.clientWidth+1));
  expect(await fits()).toBe(true); await page.getByRole('button',{name:'Manage servers',exact:true}).click(); expect(await fits()).toBe(true);
});
