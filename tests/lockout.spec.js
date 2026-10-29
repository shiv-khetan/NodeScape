// Stopping or disabling a unit that carries the SSH connection must say so and need an explicit acknowledgement.
const { test, expect } = require('@playwright/test');
const { openDemo, openServer, nav } = require('./helpers');
const F = require('./fixtures');

const menuAction = async (page, unit, action) => {
  const row = page.locator('tbody tr', { hasText: unit }).first();
  const button = row.locator('[data-svc="' + action + '"]');
  if (!await button.isVisible()) await row.getByRole('button', { name: /More actions/ }).click();
  await button.click();
  return page.locator('.confirm-dialog');
};

for (const [unit, action] of [['ssh.service', 'stop'], ['tailscaled.service', 'stop'], ['ssh.service', 'disable']]) test(`${action} ${unit} warns about losing the connection and needs a tick`, async ({ page }) => {
  await openDemo(page);
  await nav(page, 'Services');
  const dialog = await menuAction(page, unit, action);
  await expect(dialog).toContainText("can end NodeScape’s connection");
  await expect(dialog).toContainText('physical access');
  const submit = dialog.locator('[type=submit]');
  await expect(submit).toBeDisabled();
  await dialog.getByLabel('I have another way into nas-01').check();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).toHaveCount(0);
  const call = (await page.evaluate(() => window.__calls)).filter(c => c.cmd === 'service_action').at(-1);
  expect(call.args).toMatchObject({ unit, action });
});

test('cancelling the lockout warning sends nothing', async ({ page }) => {
  await openDemo(page);
  await nav(page, 'Services');
  const dialog = await menuAction(page, 'ssh.service', 'stop');
  await dialog.locator('[data-cancel]').click();
  expect((await page.evaluate(() => window.__calls)).some(c => c.cmd === 'service_action')).toBe(false);
});

test('ordinary units and restart keep the plain confirm', async ({ page }) => {
  await openDemo(page);
  await nav(page, 'Services');
  let dialog = await menuAction(page, 'caddy.service', 'stop');
  await expect(dialog).not.toContainText('another way into');
  await expect(dialog.locator('[type=submit]')).toBeEnabled();
  await dialog.locator('[data-cancel]').click();
  dialog = await menuAction(page, 'ssh.service', 'restart');
  await expect(dialog).not.toContainText('another way into');
});

test('the lockout check matches connection units only', async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT });
  const result = await page.evaluate(async () => {
    const { carriesConnection } = await import('/pages/services.js');
    return ['ssh.service', 'sshd.service', 'ssh.socket', 'tailscaled.service', 'NetworkManager.service', 'systemd-networkd.service', 'networking.service', 'nftables.service', 'ufw.service', 'firewalld.service', 'wpa_supplicant@wlan0.service',
      'caddy.service', 'sshguard.service', 'jellyfin.service', 'tailscale-web.service'].map(carriesConnection);
  });
  expect(result).toEqual([true, true, true, true, true, true, true, true, true, true, true, false, false, false, false]);
});
