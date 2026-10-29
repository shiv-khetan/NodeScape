// Full sweep with the better-ui, better-typography, better-colors, modern-css-html and frontend-ui-engineering skills.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { openDemo, openServer, nav, installBackend, APP } = require('./helpers');
const F = require('./fixtures');

const src = f => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8');
const css = () => ['style.css', ...fs.readdirSync(path.join(__dirname, '../src/styles')).map(f => 'styles/' + f)].map(f => [f, src(f)]);
const px = v => parseFloat(v);

test('surfaces: nested corners are concentric (inner = outer - padding - border)', async ({ page }) => {
  await openDemo(page);
  await nav(page, 'Services');
  const tabs = page.locator('.segtabs').first();
  const [outer, pad, border, inner] = await tabs.evaluate(el => { const s = getComputedStyle(el), b = getComputedStyle(el.querySelector('button')); return [s.borderTopLeftRadius, s.paddingTop, s.borderTopWidth, b.borderTopLeftRadius]; });
  expect(px(inner)).toBe(px(outer) - px(pad) - px(border));
  await page.locator('tbody tr').first().getByRole('button', { name: /More actions/ }).click();
  const menu = await page.locator('.row-menu:popover-open').evaluate(el => { const s = getComputedStyle(el), b = getComputedStyle(el.querySelector('button')); return [s.borderTopLeftRadius, s.paddingTop, s.borderTopWidth, b.borderTopLeftRadius]; });
  expect(px(menu[3])).toBe(px(menu[0]) - px(menu[1]) - px(menu[2]));
});

test('icons: rendered stroke matches the label weight (2px beside medium, 1.5px beside regular)', async ({ page }) => {
  await openDemo(page);
  const strokes = await page.evaluate(() => [...document.querySelectorAll('#nav svg, .search svg')].map(s => {
    const shape = s.querySelector('path,rect,circle');
    const scale = getComputedStyle(shape).vectorEffect === 'non-scaling-stroke' ? 1 : s.getBoundingClientRect().width / s.viewBox.baseVal.width;
    return [s.closest('#nav') ? 'nav' : 'search', +(parseFloat(getComputedStyle(shape).strokeWidth) * scale).toFixed(2)];
  }));
  for (const [where, w] of strokes) expect(w, where).toBe(where === 'nav' ? 2 : 1.5);
});

test('typography: two display sizes for metrics, steps at 12px or more, wrapping meta at 1.4', async ({ page }) => {
  await openDemo(page);
  const sizes = await page.evaluate(() => [...new Set([...document.querySelectorAll('.bignum b, .huge, .temp-value, .stats b, .vs b')].map(e => getComputedStyle(e).fontSize))]);
  expect(sizes.sort()).toEqual(['24px', '36px']);
  for (const [file, text] of css()) expect(text, file).not.toMatch(/letter-spacing:\s*-\.0[3-9]em/);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--line-meta').trim())).toBe('1.4');
  const steps = page.context().newPage(); const p = await steps;
  await installBackend(p, { host: null, profiles: [] }); await p.goto(APP);
  expect(px(await p.locator('.setup-steps li').first().evaluate(el => getComputedStyle(el, '::before').fontSize))).toBeGreaterThanOrEqual(12);
  await p.close();
});

test('typography: prose is capped near 75 characters and copy uses typographic apostrophes', async ({ page }) => {
  await openServer(page, { snapshot: { error: { kind: 'host_key_unknown', message: 'Trust check rejected the connection.' } } });
  await expect(page.locator('.unreachable h2')).toHaveText('Can’t reach testbox');
  await expect(page.locator('.unreachable')).toContainText('host key isn’t trusted yet');
  const [cap, measure] = await page.locator('.unreachable p').last().evaluate(el => {
    const probe = document.createElement('span'); probe.style.cssText = 'position:absolute;inline-size:75ch'; el.append(probe);
    const out = [parseFloat(getComputedStyle(el).maxInlineSize), probe.getBoundingClientRect().width]; probe.remove(); return out;
  });
  expect(Math.abs(cap - measure)).toBeLessThan(1);
  for (const f of ['pages/services.js', 'pages/logs.js', 'pages/overview.js', 'ui/errors.js', 'app.js']) expect(src(f), f).not.toMatch(/\b(Can|isn|won|NodeScape|user|server|host)'(t|s)\b|Can&#39;t/);
});

test('color: tokens are named for their role, not their hue', async () => {
  for (const [file, text] of css()) expect(text, file).not.toMatch(/var\(--(green|violet|dark|hover)\)/);
  expect(src('ui/terminal.js')).not.toContain("'--dark'");
});

test('modern CSS: dynamic viewport units, range media queries, logical offsets, dialog entrance', async ({ page }) => {
  for (const [file, text] of css()) {
    expect(text, file).not.toMatch(/100vh/);
    expect(text, file).not.toMatch(/\((max|min)-(width|height):/);
    expect(text, file).not.toMatch(/(?<![-\w])(left|right):\s*\d/);
  }
  await openDemo(page);
  const starting = await page.evaluate(() => [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } }).some(r => r.cssText.includes('@starting-style')));
  expect(starting).toBe(true);
});

test('engineering: shell file stays small; loading shows a skeleton; empty tables say so', async ({ page }) => {
  expect(src('app.js').split('\n').length).toBeLessThanOrEqual(200);
  await openDemo(page);
  await page.evaluate(() => { const old = window.__TAURI__.core.invoke; window.__TAURI__.core.invoke = (cmd, args) => cmd === 'services_read' ? new Promise(() => {}) : old(cmd, args); });
  await nav(page, 'Services');
  await expect(page.locator('#main .skeleton i')).toHaveCount(3);
  const empty = await page.context().newPage();
  await openServer(empty, { snapshot: F.SNAPSHOT, processes: '' });
  await nav(empty, 'Processes');
  await expect(empty.locator('tbody')).toContainText('No processes');
  await empty.close();
  await nav(page, 'Users');
  await expect(page.locator('tr', { hasText: 'extra' }).first()).toContainText('No members');
});

test('polish: buttons drop the touch flash; reduced motion keeps fades but drops movement', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openDemo(page);
  await expect(page.locator('#refresh')).toHaveCSS('-webkit-tap-highlight-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('#toast')).toHaveCSS('transition-property', 'opacity');
});
