// Visual regressions found in the post-redesign review.
const { test, expect } = require('@playwright/test');
const { openDemo, nav } = require('./helpers');

test.beforeEach(async ({ page }) => openDemo(page));

const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('load gauge value and caption do not overlap', async ({ page }) => {
  const value = await page.locator('.gauge .c b').boundingBox();
  const caption = await page.locator('.gauge .c span').boundingBox();
  expect(overlap(value, caption)).toBe(false);
  // Glyphs overflow a line box shorter than the font size, so boxes alone can miss the overlap.
  const fontSize = await page.locator('.gauge .c b').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  expect(value.height).toBeGreaterThanOrEqual(fontSize);
});

test('problem rows use a tint, never a colored side stripe', async ({ page }) => {
  for (const name of ['Services', 'Logs']) {
    await nav(page, name);
    await expect(page.locator('.hero h1')).toHaveText(name);
    const stripes = await page.locator('tr, .logrow').evaluateAll(rows => rows.filter(r => {
      const s = getComputedStyle(r);
      return s.boxShadow.includes('inset') || parseFloat(s.borderLeftWidth) > 1;
    }).length);
    expect(stripes, name).toBe(0);
  }
});

test('filter groups never show a single option', async ({ page }) => {
  for (const name of ['Overview', 'Services', 'Processes', 'Logs', 'Scheduled', 'Network', 'Files', 'Users']) {
    await nav(page, name);
    await expect(page.locator('.hero h1')).toHaveText(name);
    const lonely = await page.locator('.segtabs').evaluateAll(groups => groups.filter(g => g.querySelectorAll('button').length < 2).length);
    expect(lonely, name).toBe(0);
  }
});

test('network port search and filters live with the ports table', async ({ page }) => {
  await nav(page, 'Network');
  await expect(page.locator('#network-ports #network-filter')).toBeVisible();
  await expect(page.locator('#network-ports .segtabs')).toBeVisible();
  await expect(page.locator('.page-meta')).toContainText('listening port');
});

test('files toolbar groups create and upload actions; no root-only breadcrumb', async ({ page }) => {
  await nav(page, 'Files');
  const toolbar = page.locator('.page-toolbar');
  for (const action of ['mkdir', 'create', 'upload']) await expect(toolbar.locator(`[data-file-action="${action}"]`)).toBeVisible();
  await expect(page.locator('#files-crumbs')).toBeHidden();
});
