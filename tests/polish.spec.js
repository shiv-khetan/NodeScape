// Visual regressions found in the post-redesign review.
const { test, expect } = require('@playwright/test');
const { openDemo, nav } = require('./helpers');

test.beforeEach(async ({ page }) => openDemo(page));

const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

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

test('files header groups create and upload actions; no root-only breadcrumb', async ({ page }) => {
  await nav(page, 'Files');
  for (const action of ['mkdir', 'create']) await expect(page.locator(`.header-actions [data-file-action="${action}"]`)).toBeVisible();
  await expect(page.locator('.header-actions [data-file-action="upload"]')).toBeVisible();
  await expect(page.locator('#files-crumbs')).toBeHidden();
});

test('non-destructive actions that need a password get a primary button, not a red one', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const { installBackend, APP } = require('./helpers');
  await installBackend(page, { responses: { service_action: [{ error: { kind: 'sudo_required', message: 'sudo: a password is required' } }, 'ok'] } });
  await page.goto(APP);
  await nav(page, 'Services');
  await page.locator('[data-svc="start"]:visible').first().click();
  const dialog = page.locator('.confirm-dialog');
  const submit = dialog.locator('button[type="submit"]');
  await expect(submit).toHaveClass(/primary/);
  await expect(submit).not.toHaveClass(/danger/);
  await expect(dialog).toContainText('The service will start now.');
  await page.close();
});
