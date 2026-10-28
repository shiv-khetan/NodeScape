// The window can be resized down to tauri.conf.json's minWidth/minHeight. Every page must fit
// the window width at every size (vertical scrolling is fine) and reflow when the window is resized.
const { test, expect } = require('@playwright/test');
const conf = require('../src-tauri/tauri.conf.json');
const { openDemo, nav } = require('./helpers');

const win = conf.app.windows[0];
const SIZES = [[win.minWidth, win.minHeight], [1000,800], [1024, 768], [1280, 800], [1440, 900], [1920, 1080], [2560, 1440]];
const PAGES = ['Overview', 'Services', 'Processes', 'Logs', 'Scheduled', 'Network', 'Terminal', 'Files', 'Users'];

// Everything that sticks out sideways: the page itself, the header, or content wider than its card.
const overflow = page => page.evaluate(() => {
  const bad = [];
  const root = document.documentElement;
  if (root.scrollWidth > innerWidth + 1) bad.push(`page ${root.scrollWidth}px > window ${innerWidth}px`);
  for (const el of document.querySelectorAll('header, .hero, .card:not(.insight)')) {
    if (el.scrollWidth > el.clientWidth + 1) {
      bad.push(`${el.tagName.toLowerCase()}.${el.className} "${el.querySelector('h1,h2')?.textContent ?? ''}" ${el.scrollWidth}px > ${el.clientWidth}px`);
    }
  }
  // Header items must stay inside the window and not overlap each other.
  const items = [...document.querySelectorAll('.sidebar > *')].map(e => e.getBoundingClientRect());
  const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  items.forEach((r, i) => {
    if (r.right > innerWidth + 1) bad.push(`header item ${i} past the right edge`);
    items.slice(0, i).forEach((q, j) => hit(r, q) && bad.push(`header items ${j}/${i} overlap`));
  });
  return bad;
});

test('minimum window size is usable on small laptop screens', () => {
  expect(win.minWidth).toBeLessThanOrEqual(800);
  expect(win.minHeight).toBeLessThanOrEqual(600);
});

for (const [w, h] of SIZES) {
  test(`every page fits a ${w}x${h} window`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await openDemo(page);
    for (const name of PAGES) {
      await nav(page, name);
      await expect(page.locator('.hero h1')).toHaveText(name);
      await expect(page.locator('.card').first()).toBeVisible();
      expect(await overflow(page), `${name} at ${w}x${h}`).toEqual([]);
    }
  });
}

test('layout reflows while the window is resized', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openDemo(page);
  for (const [w, h] of [[1920, 1080], [win.minWidth, win.minHeight], [1280, 800], [2560, 1440], [win.minWidth, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await expect.poll(() => overflow(page), `overview after resize to ${w}x${h}`).toEqual([]);
    // Charts follow their card's width instead of keeping the old size.
    const fit = await page.evaluate(() => {
      const box = document.querySelector('.step');
      const svg = box.querySelector('svg').getBoundingClientRect();
      return Math.abs(svg.width - box.getBoundingClientRect().width) < 2;
    });
    expect(fit, `CPU history chart at ${w}px`).toBe(true);
  }
});

test('very wide windows keep content at a readable width, centred', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await openDemo(page);
  const [m, hd] = await Promise.all(['main', '.sidebar'].map(s => page.locator(s).evaluate(e => e.getBoundingClientRect().toJSON())));
  expect(m.width - 48).toBeLessThanOrEqual(1800);
  expect(Math.abs((m.left - hd.right) - (2560 - m.right))).toBeLessThan(2);
  expect(hd.width).toBe(216);
  expect(hd.left).toBe(0);
});

test('narrow windows stack cards instead of squeezing them', async ({ page }) => {
  await page.setViewportSize({ width: win.minWidth, height: win.minHeight });
  await openDemo(page);
  const widths = await page.locator('.grid > .card').evaluateAll(cards => cards.map(c => c.getBoundingClientRect().width));
  expect(Math.min(...widths), 'narrowest card').toBeGreaterThanOrEqual(240);
});
