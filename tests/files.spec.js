const { test, expect } = require('@playwright/test');
const { openDemo, nav } = require('./helpers');
const unicode = 'ü ñ 文件 test.txt';
const row = (page, name) => page.locator('.files-row').filter({ has: page.locator('.file-name', { hasText: name }) });
async function openFiles(page) { await openDemo(page); await nav(page, 'Files'); await expect(page.locator('#files-path')).toHaveValue('/'); }
async function nameDialog(page, name) { await page.getByLabel('Name', { exact: true }).fill(name); await page.getByRole('button', { name: 'Apply', exact: true }).click(); }

test('browse, Unicode names, symlinks and breadcrumbs', async ({ page }) => {
  await openFiles(page);
  await expect(row(page, unicode)).toBeVisible();
  await expect(row(page, 'shortcut')).toContainText('→ /documents');
  await expect(row(page, 'dangling')).toContainText('→ /missing');
  await row(page, 'documents').getByRole('button', { name: 'Open folder' }).click();
  await expect(page.locator('#files-path')).toHaveValue('/documents');
  await page.getByRole('button', { name: 'Root directory' }).click();
  await expect(row(page, unicode)).toBeVisible();
});
test('create folder and empty file, rename refuses collisions', async ({ page }) => {
  await openFiles(page);
  await page.getByRole('button', { name: 'New folder', exact: true }).click(); await nameDialog(page, 'new folder');
  await expect(row(page, 'new folder')).toBeVisible();
  await page.getByRole('button', { name: 'New file', exact: true }).click(); await nameDialog(page, 'new file.txt');
  await row(page, 'new file.txt').getByRole('button', { name: 'Rename', exact: true }).click(); await nameDialog(page, 'renamed ü.txt');
  await expect(row(page, 'renamed ü.txt')).toBeVisible();
  await row(page, 'renamed ü.txt').getByRole('button', { name: 'Rename', exact: true }).click(); await nameDialog(page, unicode);
  await expect(page.locator('#files-error')).toContainText('exists');
});
test('delete cancellation and recursive second confirmation are explicit', async ({ page }) => {
  await openFiles(page);
  page.once('dialog', d => d.dismiss());
  await row(page, unicode).getByRole('button', { name: 'Delete', exact: true }).click(); await expect(row(page, unicode)).toBeVisible();
  let dialogs = 0; page.on('dialog', async d => { dialogs++; await d.accept(); });
  await row(page, 'documents').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Delete recursively' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete recursively' }).click();
  await expect(row(page, 'documents')).toHaveCount(0); expect(dialogs).toBe(2);
  expect(await page.evaluate(() => window.__calls.filter(x => x.cmd === 'file_delete').map(x => x.args.recursive))).toEqual([false, true]);
});
test('editor saves Unicode and preserves text on conflict', async ({ page }) => {
  await openFiles(page);
  await row(page, unicode).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('File text').fill('saved ü ñ 文件');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#files-editor')).toBeHidden();
  await row(page, unicode).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('File text')).toHaveValue('saved ü ñ 文件');
  await page.evaluate(() => { window.__filesConflict = true; });
  await page.getByLabel('File text').fill('keep my edit');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#files-editor-error')).toContainText('changed');
  await expect(page.getByLabel('File text')).toHaveValue('keep my edit');
  await page.getByRole('button', { name: 'Cancel editing' }).click();
});
test('native pickers, upload/download progress and cancel', async ({ page }) => {
  await openFiles(page);
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.locator('.file-transfer')).toContainText('upload.txt');
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
  await page.getByRole('button', { name: 'Cancel transfer' }).click();
  await expect(page.locator('.file-transfer')).toContainText('Cancelled');
  await row(page, unicode).getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.locator('.file-transfer').last()).toContainText(unicode);
  await page.evaluate(() => window.__finishTransfers());
  await expect(page.locator('.file-transfer').last()).toContainText('Complete');
  expect(await page.evaluate(() => window.__calls.some(x => x.cmd === 'plugin:dialog|open'))).toBe(true);
  expect(await page.evaluate(() => window.__calls.some(x => x.cmd === 'plugin:dialog|save'))).toBe(true);
});
test('permission denied and not found remain inline; untrusted text is escaped', async ({ page }) => {
  await openFiles(page);
  await page.locator('#files-path').fill('/denied'); await page.locator('#files-path').press('Enter');
  await expect(page.locator('#files-error')).toContainText('Permission denied');
  await page.locator('#files-path').fill('/missing'); await page.locator('#files-path').press('Enter');
  await expect(page.locator('#files-error')).toContainText('not found');
  await page.locator('#files-path').fill('/'); await page.locator('#files-path').press('Enter');
  await expect(row(page, '<img src=x onerror=alert(1)>')).toBeVisible();
  expect(await page.locator('.files-row img').count()).toBe(0);
});
for (const [width, height] of [[800,600],[1024,768],[1280,800],[1440,900],[1920,1080],[2560,1440]]) {
  test('files layout '+width+'x'+height, async ({ page }) => {
    await page.setViewportSize({width,height}); await openFiles(page);
    await row(page, unicode).getByRole('button', { name: 'Edit', exact: true }).click();
    expect(await page.evaluate(() => {
      const bad=[]; if(document.documentElement.scrollWidth>innerWidth+1)bad.push('page');
      for(const el of document.querySelectorAll('header,.hero,.card'))if(el.scrollWidth>el.clientWidth+1)bad.push(el.className);
      return bad;
    })).toEqual([]);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  });
}
