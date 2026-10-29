// Rules from the typography, color, UI-polish, modern CSS and frontend engineering checklists.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { openDemo, openServer, nav } = require('./helpers');
const F = require('./fixtures');

const src = f => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8');
const sheets = () => ['style.css', ...fs.readdirSync(path.join(__dirname, '../src/styles')).map(f => 'styles/' + f)].map(f => [f, src(f)]);
const outsideRoot = css => css.replace(/:root\s*\{[^}]*\}/g, '');

test('typography: unitless line-heights, rem sizes, balanced headings, smoothing on the root', async ({ page }) => {
  await openDemo(page);
  const root = await page.evaluate(() => { const s = getComputedStyle(document.documentElement); return ['--line-body', '--line-meta', '--line-title', '--font-body', '--font-meta', '--font-title'].map(v => s.getPropertyValue(v).trim()); });
  for (const v of root.slice(0, 3)) expect(v).toMatch(/^\d+(\.\d+)?$/);
  for (const v of root.slice(3)) expect(v).toMatch(/rem$/);
  for (const [file, css] of sheets()) {
    expect(css, file).not.toMatch(/line-height:\s*[\d.]+px/);
    expect(css, file).not.toMatch(/font-size:\s*[\d.]+px/);
  }
  await expect(page.locator('.hero h1')).toHaveCSS('text-wrap', /balance/);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).webkitFontSmoothing)).toBe('antialiased');
});

test('typography: tabular figures on numbers only, so names keep normal hyphens', async ({ page }) => {
  await openDemo(page);
  await nav(page, 'Services');
  await expect(page.locator('tbody tr').first().locator('td').first()).toHaveCSS('font-variant-numeric', 'normal');
  await nav(page, 'Processes');
  await expect(page.locator('td.num').first()).toHaveCSS('font-variant-numeric', 'tabular-nums');
});

test('color: no raw color literals outside the token block, and native controls follow the light scheme', async ({ page }) => {
  for (const [file, css] of sheets()) expect(outsideRoot(css), file).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  for (const f of ['ui/charts.js', ...fs.readdirSync(path.join(__dirname, '../src/pages')).map(f => 'pages/' + f)]) expect(src(f), f).not.toMatch(/#[0-9a-f]{6}\b/i);
  await openDemo(page);
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
});

test('color is never the only signal: error log rows carry a visible label', async ({ page }) => {
  await openServer(page, { snapshot: F.SNAPSHOT, logs: F.LOGS_LIMITED });
  await expect(page.locator('.timeline .logrow.err .sev').first()).toHaveText('Error');
  await nav(page, 'Logs');
  await expect(page.locator('.logrow.err .sev')).toHaveText(['Error']);
  await expect(page.locator('.logrow:not(.err) .sev')).toHaveCount(0);
});

test('polish: hover styles only for hover-capable pointers, press feedback, contained overlay scroll', async ({ page }) => {
  await openDemo(page);
  const bare = await page.evaluate(() => {
    const out = [];
    const walk = (rules, guarded) => { for (const r of rules) {
      if (r instanceof CSSMediaRule) walk(r.cssRules, guarded || /hover:\s*hover/.test(r.conditionText));
      else if (r.selectorText && r.selectorText.includes(':hover') && !guarded) out.push(r.selectorText);
    } };
    for (const s of document.styleSheets) { try { walk(s.cssRules, false); } catch {} }
    return out;
  });
  expect(bare).toEqual([]);
  const press = await page.evaluate(() => [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } })
    .flatMap(r => r.cssRules ? [...r.cssRules] : [r]).filter(r => r.selectorText?.includes(':active') && r.selectorText.includes(':not(:disabled)')).map(r => r.style.scale));
  expect(press).toContain('0.96');
  await page.keyboard.press('Control+k');
  await expect(page.locator('.palette ul')).toHaveCSS('overscroll-behavior-y', 'contain');
  await page.keyboard.press('Escape');
  await page.locator('#settingsBtn').click();
  await expect(page.locator('#settings')).toHaveCSS('overscroll-behavior-y', 'contain');
});

test('modern CSS: logical properties instead of physical left/right', async () => {
  for (const [file, css] of sheets()) expect(css, file).not.toMatch(/(margin|padding)-(left|right)\s*:|text-align:\s*(left|right)/);
});

test('loading state: navigation shows the page header and a busy status, not a blank page', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(() => { const old = window.__TAURI__.core.invoke; window.__TAURI__.core.invoke = (cmd, args) => cmd === 'services_read' ? new Promise(() => {}) : old(cmd, args); });
  await nav(page, 'Services');
  await expect(page.locator('.hero h1')).toHaveText('Services');
  const busy = page.locator('#main [role="status"][aria-busy="true"]');
  await expect(busy).toBeVisible();
  await expect(busy).toContainText('Loading');
});

test('restart is a repair, so its confirm button is primary, not red', async ({ page }) => {
  await openDemo(page);
  await nav(page, 'Services');
  await page.locator('tbody tr', { hasText: 'caddy.service' }).locator('[data-svc="restart"]').click();
  await expect(page.locator('.confirm-dialog [type=submit]')).toHaveClass(/primary/);
});
