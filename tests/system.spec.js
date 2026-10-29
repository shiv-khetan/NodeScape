const { test, expect } = require('@playwright/test');
const { openServer, nav } = require('./helpers');
const F = require('./fixtures');

const section = (snapshot, name, text) => {
  const marker = '@' + name;
  const lines = snapshot.split('\n');
  const start = lines.indexOf(marker);
  if (start < 0) return snapshot + '\n' + marker + '\n' + text;
  let end = start + 1;
  while (end < lines.length && !/^@\w+$/.test(lines[end])) end++;
  lines.splice(start + 1, end - start - 1, ...text.split('\n'));
  return lines.join('\n');
};
const sensors = JSON.stringify({
  'coretemp-isa-0000': { Adapter: 'ISA adapter',
    'Package id 0': { temp1_input: 78, temp1_max: 80, temp1_crit: 100 },
    'Core 0': { temp2_input: 42.5, temp2_max: 80, temp2_crit: 100 },
    '<img src=x onerror="window.sensorInjected=true">': { temp3_input: 31 },
    'fan': { fan1_input: 1400 },
    'missing': { temp4_input: null },
  },
});
const base = section(section(F.SNAPSHOT, 'disk', '107374182400 53687091200 /srv/my media'), 'groups', 'testuser adm');
const card = (page, title) => page.locator('article.card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const open = async (page, snapshot = base, logs = '') => {
  await openServer(page, { snapshot, logs });
  await expect(page.locator('.hero h1')).toHaveText('Overview');
  await page.locator('[data-act="live"]').click();
};
const parsed = page => page.evaluate(async () => (await import('/state.js')).state.snap);

test('sensors JSON shows hottest reading, thresholds and escaped labels', async ({ page }) => {
  await open(page, section(base, 'temps', sensors));
  const temps = card(page, 'Temperatures');
  await expect(temps.locator('.temp-value')).toHaveText('78 °C');
  await expect(temps.locator('.meter')).toHaveCount(3);
  await expect(temps.locator('.meter').first()).toContainText('Package');
  await expect(temps.locator('.meter').first().locator('.track i')).toHaveClass(/neutral/);
  await expect(temps.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.sensorInjected)).toBeUndefined();
  expect((await parsed(page)).temps[0]).toMatchObject({ label: 'coretemp-isa-0000 · Package id 0', celsius: 78, high: 80, crit: 100 });
});

test('thermal zone fallback preserves labels and converts millidegrees', async ({ page }) => {
  await open(page, section(base, 'temps', 'x86_pkg_temp\n47000\nacpitz\n38500'));
  await expect(card(page, 'Temperatures').locator('.temp-value')).toHaveText('47 °C');
  expect((await parsed(page)).temps).toEqual([{ label: 'x86_pkg_temp', celsius: 47 }, { label: 'acpitz', celsius: 38.5 }]);
});

test('missing sensors never appear as zero Celsius', async ({ page }) => {
  await open(page, section(base, 'temps', ''));
  await expect(card(page, 'Temperatures')).toContainText('Temperature sensors unavailable (install lm-sensors)');
  await expect(card(page, 'Temperatures')).not.toContainText('0 °C');
});

test('malformed temperature readings are unavailable and critical readings are marked', async ({ page }) => {
  await open(page, section(base, 'temps', '{bad json}'));
  await expect(card(page, 'Temperatures')).toContainText('Temperature sensors unavailable');
  const result = await page.evaluate(async () => {
    const { parseSnapshot } = await import('/ui/parse.js');
    return parseSnapshot('@temps\n' + JSON.stringify({ chip: { bad: { temp1_input: 'bad' }, cold: { temp2_input: -5 }, hot: { temp3_input: 101, temp3_max: 80, temp3_crit: 100 } } }), 'testbox').temps;
  });
  expect(result).toEqual([{ label: 'chip · cold', celsius: -5 }, { label: 'chip · hot', celsius: 101, high: 80, crit: 100 }]);
  await page.evaluate(async () => {
    const { render } = await import('/pages/overview.js');
    const { state } = await import('/state.js');
    state.snap.temps = [{ label: 'CPU', celsius: 101, high: 80, crit: 100 }];
    document.querySelector('#main').innerHTML = render(state.snap);
  });
  await expect(card(page, 'Temperatures').locator('.track i')).toHaveClass(/hot/);
});

test('disk target retains spaces and usage uses the numeric columns', async ({ page }) => {
  await open(page);
  await expect(page.locator('.meter', { hasText: '/srv/my media' })).toContainText('50% of 100.0 GiB');
  expect((await parsed(page)).disks).toEqual([{ target: '/srv/my media', size: 107374182400, used: 53687091200 }]);
});

test('zero swap means no swap while missing swap is unavailable', async ({ page }) => {
  await open(page, section(base, 'mem', 'Mem: 17179869184 4294967296 4294967296 0 8589934592 12884901888\nSwap: 0 0 0'));
  await expect(card(page, 'Memory')).toContainText('no swap');
  await expect(card(page, 'Memory')).not.toContainText('Swap unavailable');
});

test('missing memory, swap, disks and load stay unavailable', async ({ page }) => {
  let snapshot = base;
  for (const name of ['mem', 'disk', 'load', 'cpus']) snapshot = section(snapshot, name, '');
  await open(page, snapshot);
  await expect(card(page, 'Memory')).toContainText('Memory unavailable');
  await expect(card(page, 'Memory')).toContainText('Swap unavailable');
  await expect(card(page, 'Memory')).toContainText('Disk usage unavailable');
  await expect(card(page, 'CPU').locator('.stats div', { hasText: 'Load 1m' })).toContainText('Unavailable');
  await expect(card(page, 'CPU').locator('.card-top')).not.toContainText('load');
  await expect(card(page, 'Memory')).not.toContainText('0.0 GiB');
  await expect(page.locator('#main')).not.toContainText('NaN');
});

test('groups explain limited journals on Overview and Logs without hint text', async ({ page }) => {
  await open(page, section(base, 'groups', 'testuser video docker'), '2026-01-01T10:00:00+00:00 testbox app[9]: Hello');
  await expect(card(page, 'Recent journal')).toContainText("Only this user’s journal is visible");
  await nav(page, 'Logs');
  await expect(page.locator('.notice')).toContainText("Only this user’s journal is visible");
  await expect(page.locator('.logrow')).toHaveCount(1);
});

for (const group of ['adm', 'systemd-journal', 'root']) {
  test(group + ' group permits the full journal despite stale hint text', async ({ page }) => {
    await open(page, section(base, 'groups', 'testuser ' + group), F.LOGS_LIMITED);
    await expect(card(page, 'Recent journal').locator('.notice')).toHaveCount(0);
    await nav(page, 'Logs');
    await expect(page.locator('.notice')).toHaveCount(0);
  });
}

test('Overview keeps hint detection when group data is absent', async ({ page }) => {
  await open(page, section(section(base, 'groups', ''), 'log', F.LOGS_LIMITED));
  await expect(card(page, 'Recent journal')).toContainText("Only this user’s journal is visible");
  await expect(page.locator('.timeline')).not.toContainText('Hint:');
});

test('counter resets create unavailable samples and charts recover', async ({ page }) => {
  let snapshot = section(base, 'cpu', 'cpu 100 0 100 800 0 0 0 0\ncpu 10 0 10 80 0 0 0 0');
  snapshot = section(snapshot, 'rx2', 'eth0: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0');
  await open(page, snapshot);
  await expect(card(page, 'CPU').locator('.stats .on b')).toHaveText('Unavailable');
  await expect(page.locator('.dotcard .huge')).toHaveText(['Unavailable', 'Unavailable']);
  await page.locator('#refresh').click();
  await expect.poll(async () => (await page.evaluate(async () => (await import('/state.js')).history().cpu)).length).toBe(2);
  await expect(card(page, 'CPU')).toContainText('Collecting samples (2 of 5)…');
  expect(await parsed(page)).toMatchObject({ cpu: null, rx: null, tx: null });
  await page.evaluate(async valid => {
    const old = window.__TAURI__.core.invoke;
    window.__TAURI__.core.invoke = (cmd, args) => cmd === 'query' ? Promise.resolve(valid) : old(cmd, args);
  }, base);
  await page.locator('#refresh').click();
  await expect(card(page, 'CPU').locator('.stats .on b')).toHaveText('50%');
  await expect(page.locator('.dotcard .huge').first()).toHaveText('1.0MB/s');
  expect(await page.locator('svg path').evaluateAll(paths => paths.every(p => !/NaN|Infinity/.test(p.getAttribute('d') || '')))).toBe(true);
});

test('a single reset counter cannot be hidden by other increasing counters', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const { parseSnapshot } = await import('/ui/parse.js');
    const snapshot = '@cpu\ncpu 100 0 100 800 0 0 0 0\ncpu 90 0 150 900 0 0 0 0\n@gw\ndefault dev eth0\ndefault dev eth1\n@rx1\neth0: 100 0 0 0 0 0 0 0 100 0 0 0 0 0 0 0\neth1: 100 0 0 0 0 0 0 0 100 0 0 0 0 0 0 0\n@rx2\neth0: 1 0 0 0 0 0 0 0 150 0 0 0 0 0 0 0\neth1: 1000 0 0 0 0 0 0 0 150 0 0 0 0 0 0 0';
    const { cpu, rx, tx } = parseSnapshot(snapshot, 'testbox');
    return { cpu, rx, tx };
  });
  expect(result).toEqual({ cpu: null, rx: null, tx: 200 });
});

for (const [width, height] of [[800, 600], [1024, 768], [1280, 800], [1440, 900], [1920, 1080], [2560, 1440]]) {
  test('temperature card fits ' + width + 'x' + height, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await open(page, section(base, 'temps', sensors));
    await expect(card(page, 'Temperatures').locator('.meter')).toHaveCount(3);
    expect(await page.evaluate(() => [...document.querySelectorAll('.card:not(.insight)')].every(el => el.scrollWidth <= el.clientWidth + 1) && document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
