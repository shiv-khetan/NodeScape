// Live refresh skips the 0.5 s CPU sampling sleep after the first snapshot, and updates the Overview in place.
const { test, expect } = require('@playwright/test');
const { openDemo, openServer } = require('./helpers');
const F = require('./fixtures');

const queries = page => page.evaluate(() => window.__calls.filter(c => c.cmd === 'query').map(c => c.args.what));

test('quick snapshots compute CPU and network from the previous sample', async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT });
  const out = await page.evaluate(async () => {
    const { parseSnapshot } = await import('/ui/parse.js');
    const one = (cpu, rx, tx, up) => ['@rx1', 'Inter-|', ' face |', `  eth0: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0`, '@cpu', `cpu  ${cpu.join(' ')}`, '@gw', 'default via 10.0.0.1 dev eth0', '@uptime', `${up} 0.00`].join('\n');
    const first = parseSnapshot(one([100, 0, 100, 800, 0, 0, 0, 0], 1000, 500, 100), 'testbox');
    const second = parseSnapshot(one([150, 0, 150, 900, 0, 0, 0, 0], 6000, 3000, 105), 'testbox', first.raw);
    const rebooted = parseSnapshot(one([1, 0, 1, 8, 0, 0, 0, 0], 10, 10, 3), 'testbox', second.raw);
    return { first: [first.cpu, first.rx], second: [second.cpu, second.rx, second.tx], rebooted: [rebooted.cpu, rebooted.rx] };
  });
  expect(out.first).toEqual([null, null]);
  expect(out.second[0]).toBeCloseTo(50, 5); // 100 busy of 200 total
  expect(out.second[1]).toBe(1000); // 5000 bytes over 5 s of server uptime
  expect(out.second[2]).toBe(500);
  expect(out.rebooted).toEqual([null, null]);
});

test('the first snapshot samples fully; later refreshes use the quick snapshot', async ({ page }) => {
  await openDemo(page);
  const before = await queries(page);
  expect(before[0]).toBe('snapshot');
  expect(before.slice(1).every(w => w === 'snapshot_quick')).toBe(true);
  await page.locator('#refresh').click();
  await expect.poll(async () => (await queries(page)).at(-1)).toBe('snapshot_quick');
  await expect(page.locator('.stats .on b')).not.toHaveText('Unavailable');
  // Switching server starts over with a full sample.
  await page.selectOption('#host', 'testbox');
  await expect.poll(async () => (await queries(page)).at(-1)).toBe('snapshot');
});

test('a live refresh updates the Overview in place, keeping unchanged nodes and focus', async ({ page }) => {
  await openDemo(page);
  const card = page.locator('.overview-grid > .card', { has: page.getByRole('heading', { name: 'Memory' }) });
  await card.evaluate(el => { el.dataset.marker = 'kept'; window.__memoryCard = el; });
  const pause = page.getByRole('button', { name: /Pause live updates/ });
  await pause.focus();
  await page.evaluate(() => document.querySelector('#refresh').click());
  await expect.poll(() => page.evaluate(() => window.__calls.filter(c => c.cmd === 'query').length)).toBeGreaterThan(6);
  await expect(page.locator('.stats')).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('.overview-grid').contains(window.__memoryCard))).toBe(true);
  await expect(pause).toBeFocused();
  // Pausing still works after an in-place update.
  await pause.click();
  await expect(page.getByRole('button', { name: /Resume live updates/ })).toBeVisible();
});
