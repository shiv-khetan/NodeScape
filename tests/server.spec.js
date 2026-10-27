// Real-server code paths, driven by a fake Tauri backend that returns fixture output.
const { test, expect } = require('@playwright/test');
const { openServer, nav } = require('./helpers');
const F = require('./fixtures');

const calls = page => page.evaluate(() => window.__calls);

test.describe('overview with server data', () => {
  test.beforeEach(async ({ page }) => {
    await openServer(page, { snapshot: F.SNAPSHOT });
    await expect(page.locator('.hero h1')).toHaveText('Overview');
  });

  test('shows the address this session connected to, not the first LAN IP', async ({ page }) => {
    await expect(page.locator('.hostchip')).toHaveText('testbox · 10.0.0.2');
  });

  test('computes CPU, load and uptime', async ({ page }) => {
    await expect(page.locator('.stats .on b')).toHaveText('50%');
    await expect(page.locator('.gauge .c b')).toHaveText('13%'); // load 0.50 on 4 cores
    await expect(page.locator('.insight .huge')).toHaveText('1d 1h');
  });

  test('labels binary sizes as GiB', async ({ page }) => {
    await expect(page.locator('.bignum b')).toHaveText('4.0 GiB');
    await expect(page.locator('.bignum .badge')).toHaveText('25%');
    await expect(page.locator('.meter', { hasText: '/' }).last()).toContainText('50% of 100.0 GiB');
  });

  test('counts network on the default-route interface only', async ({ page }) => {
    const nums = page.locator('.dotcard .huge');
    await expect(nums.nth(0)).toHaveText('1.0MB/s');
    await expect(nums.nth(1)).toHaveText('512KB/s');
  });

  test('counts running and failed services, ignoring not-found units', async ({ page }) => {
    await expect(page.locator('.toolbar .tag').nth(0)).toHaveText('2 running');
    await expect(page.locator('.toolbar .tag').nth(1)).toHaveText('1 failed');
  });

  test('uptime card lists Tailscale but not down interfaces', async ({ page }) => {
    const p = page.locator('.insight p');
    await expect(p).toContainText('tailscale0 100.64.0.2/32');
    await expect(p).not.toContainText('docker0');
  });

  test('highlights error lines in the journal card', async ({ page }) => {
    await expect(page.locator('.timeline .ev.err')).toContainText('repository unreachable');
  });
});

test('scheduled page works when the user has no crontab', async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT, timers: F.TIMERS_NO_CRON });
  await nav(page, 'Scheduled');
  await expect(page.locator('.hero h1')).toHaveText('Scheduled');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.getByText('No crontab entries.')).toBeVisible();
  await expect(page.locator('tbody tr').nth(1)).toContainText('—'); // empty next/last run
});

test('logs page hides journalctl notices and explains the limited view', async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT, logs: F.LOGS_LIMITED });
  await nav(page, 'Logs');
  await expect(page.locator('.notice')).toContainText("Only testbox's own user journal is visible");
  await expect(page.locator('.logrow')).toHaveCount(3);
  await expect(page.locator('.logrow').first().locator('time')).toHaveText('09:00:00');
  await expect(page.locator('.logrow', { hasText: 'Hint' })).toHaveCount(0);
  await expect(page.locator('.logrow.err')).toHaveCount(1);
});

test('logs unit filter is sent to the backend', async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT, logs: F.LOGS_LIMITED });
  await nav(page, 'Logs');
  await page.locator('#logunit').fill('nginx');
  await page.locator('#logunit').press('Enter');
  await expect(page.locator('.hostchip')).toHaveText('nginx');
  const last = (await calls(page)).filter(c => c.cmd === 'logs').at(-1);
  expect(last.args).toMatchObject({ host: 'testbox', unit: 'nginx', lines: 300 });
});

test('processes page parses ps output', async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT, processes: F.PROCESSES });
  await nav(page, 'Processes');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.locator('tbody tr').first()).toContainText('nginx');
  await expect(page.locator('tbody tr').first()).toContainText('12.5%');
});

test('unknown host key shows how to trust it safely', async ({ page }) => {
  await openServer(page, { snapshot: { error: { kind: 'host_key_unknown', message: 'Trust check rejected the connection.' } } });
  await expect(page.locator('.empty h1')).toHaveText("Can't reach testbox");
  await expect(page.locator('.empty')).toContainText("host key isn't trusted yet");
  await expect(page.locator('.error')).toHaveText('Trust check rejected the connection.');
  const changed = await page.context().newPage();
  await openServer(changed, { snapshot: { error: { kind: 'host_key_changed', message: 'The key differs.' } } });
  await expect(changed.locator('.empty')).toContainText("host key isn't trusted yet");
  await changed.close();
});

test('other connection errors show the ssh message', async ({ page }) => {
  await openServer(page, { snapshot: { error: { kind: 'timeout', message: 'ssh: connect to host 10.0.0.2 port 22: Connection timed out' } } });
  await expect(page.locator('.error')).toContainText('Connection timed out');
  await expect(page.locator('.empty')).toContainText('works in a terminal');
});

test('settings: chosen ssh config is stored and sent with every call', async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT, hosts: ['alpha', 'beta'] });
  await page.locator('#settingsBtn').click();
  await page.locator('#sshConfig').fill('"C:\\path\\to\\ssh\\config"');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#settings')).not.toBeVisible();

  // The dialog hides before its async "close" event saves, so wait for the value.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('sshConfig'))).toBe('C:\\path\\to\\ssh\\config');
  await expect.poll(async () => (await calls(page)).filter(c => c.args?.config === 'C:\\path\\to\\ssh\\config').map(c => c.cmd))
    .toEqual(expect.arrayContaining(['hosts', 'query']));
  await expect.poll(() => page.locator('#hosts option').evaluateAll(o => o.map(x => x.value))).toEqual(['alpha', 'beta']);
});

test('settings: cancel leaves the config unchanged', async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT });
  await page.locator('#settingsBtn').click();
  await page.locator('#sshConfig').fill('C:\\other\\config');
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(await page.evaluate(() => localStorage.getItem('sshConfig'))).toBeNull();
});

test('stopping a service asks first and sends the exact unit', async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT, service_action: 'ok' });
  await nav(page, 'Services');
  page.once('dialog', d => d.dismiss());
  await page.locator('[data-svc="stop"][data-u="nginx.service"]').click();
  expect((await calls(page)).some(c => c.cmd === 'service_action')).toBe(false);

  page.once('dialog', d => d.accept());
  await page.locator('[data-svc="stop"][data-u="nginx.service"]').click();
  await expect(page.locator('#toast')).toHaveText('stop nginx.service: ok');
  const act = (await calls(page)).find(c => c.cmd === 'service_action');
  expect(act.args).toMatchObject({ target: { host: 'testbox', config: null }, scope: 'system', unit: 'nginx.service', action: 'stop' });
});

test('sudo_required opens the one-action password dialog', async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT, service_action: { error: { kind: 'sudo_required', message: 'Elevation is required.' } } });
  await nav(page, 'Services');
  await page.locator('[data-svc="start"][data-u="backup.service"]').click();
  const dialog = page.getByRole('dialog', { name: 'Administrator permission' });
  await expect(dialog).toContainText('used once');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});
