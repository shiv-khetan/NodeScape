const { test, expect } = require('@playwright/test');
const { openDemo, nav } = require('./helpers');
const pages = ['Overview', 'Services', 'Processes', 'Logs', 'Scheduled', 'Network', 'Terminal', 'Files', 'Users', 'Manage servers', 'Add server'];
async function visit(page, name) {
  if (['Manage servers', 'Add server'].includes(name)) await page.locator(name === 'Add server' ? '#addServer' : '#manageServers').click();
  else await nav(page, name);
  await expect(page.locator('.hero h1')).toHaveText(name === 'Add server' ? 'Add a server' : name);
  if (name === 'Files') await expect(page.locator('#files-path')).toHaveValue('/');
}
// Radius checks include charts, popovers, dialogs and the terminal renderer.
async function radiusViolations(page) {
  return page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.checkVisibility()).flatMap(e => {
    const s = getComputedStyle(e), r = e.getBoundingClientRect();
    const values = [s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomLeftRadius,s.borderBottomRightRadius];
    const dot = r.width <= 9 && r.height <= 9 && values.every(v => v === '50%');
    return !dot && values.some(v => parseFloat(v) > 12) ? [e.tagName + '.' + e.className + ': ' + values.join(' ')] : [];
  }));
}
async function contrastViolations(page) {
  return page.evaluate(() => {
    const rgb = s => (s.match(/[\d.]+/g) || []).map(Number);
    const luminance = c => c.slice(0,3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((n,v,i) => n + v * [.2126,.7152,.0722][i],0);
    const bad = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode, e = n.parentElement;
      // SVG chart labels are verified visually; offscreen measurement nodes are not visible text.
      if (!n.textContent.trim() || !e.checkVisibility() || e.closest('svg,script,style') || e.getBoundingClientRect().right < 0) continue;
      const s = getComputedStyle(e); let bg = [255,255,255];
      for (let a = e; a; a = a.parentElement) { const c = rgb(getComputedStyle(a).backgroundColor); if (c.length === 3 || c[3] === 1) { bg = c; break; } }
      const color = rgb(s.color), l1 = luminance(color), l2 = luminance(bg), ratio = (Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05);
      const large = parseFloat(s.fontSize) >= 24 || parseFloat(s.fontSize) >= 18.66 && parseFloat(s.fontWeight) >= 700;
      if (ratio + .01 < (large ? 3 : 4.5)) bad.push(n.textContent.trim().slice(0,60) + ': ' + ratio.toFixed(2));
    }
    return bad;
  });
}

test.beforeEach(async ({ page }) => {
  page.on('dialog', async d => { await d.dismiss(); throw new Error('Native dialog triggered: ' + d.type()); });
  await openDemo(page);
  await page.locator('[data-act="live"]').click();
});
for (const name of pages) test(name + ' uses the radius, contrast, and keyboard focus system', async ({ page }) => {
  await visit(page, name);
  expect(await radiusViolations(page)).toEqual([]);
  expect(await contrastViolations(page)).toEqual([]);
  const focusables = page.locator('button:visible:enabled, .field:visible:enabled');
  const count = await focusables.count();
  for (let i = 0; i < count; i++) {
    const el = focusables.nth(i);
    await el.focus(); await page.keyboard.press('Shift');
    expect(await el.evaluate(e => {const s=getComputedStyle(e); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2 || s.boxShadow !== 'none';}), await el.getAttribute('class')).toBe(true);
  }
});

test('sidebar selection and icon rail retain accessible controls', async ({ page }) => {
  for (const width of [800,1000,1001,1440,2560]) {
    await page.setViewportSize({width,height:600});
    await nav(page,'Services');
    await expect(page.locator('[data-view="services"]')).toHaveAttribute('aria-current','page');
    expect(await page.locator('.sidebar').evaluate(e => e.getBoundingClientRect().width)).toBe(width <= 1000 ? 56 : 216);
    for (const label of pages.slice(0,9)) await expect(page.getByRole('button',{name:label,exact:true}).first()).toHaveAccessibleName(label);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.sidebar button').evaluateAll(buttons=>buttons.every(b=>{const r=b.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}))).toBe(true);
  }
});

test('services prioritize problems, expose state actions, filter and contain keyboard menus', async ({ page }) => {
  await nav(page,'Services');
  await expect(page.locator('tbody tr').first()).toHaveAttribute('data-st','failed');
  const running=page.locator('tr[data-st="running"]').first();
  await expect(running.locator('[data-svc="start"]:visible')).toHaveCount(0);
  await expect(running.getByRole('button',{name:'Restart',exact:true})).toBeVisible();
  await expect(running.getByRole('button',{name:'Stop',exact:true})).toBeVisible();
  await page.locator('[data-state="failed"]').click();
  await expect(page.locator('tbody tr:visible')).toHaveCount(2);
  const more=page.locator('tbody tr:visible').first().getByRole('button',{name:/More actions/});
  await more.click();
  const menu=page.locator('.row-menu:popover-open');
  await expect(menu).toBeVisible();
  expect(await menu.evaluate(e => {const r=e.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})).toBe(true);
  expect(await radiusViolations(page)).toEqual([]); expect(await contrastViolations(page)).toEqual([]);
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(more).toBeFocused();
  await more.press('Enter'); await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement.closest('.row-menu'))).toBe(true);
  await page.mouse.click(600,10); await expect(menu).toHaveCount(0);
});

for (const action of ['stop','restart','disable']) test(action + ' confirms context, cancels safely and runs once', async ({ page }) => {
  await nav(page,'Services');
  const row=page.locator('tbody tr[data-st="running"]').first();
  const name=await row.locator('.who p').innerText();
  if (action==='disable') await row.getByRole('button',{name:/More actions/}).click();
  await row.locator('[data-svc="'+action+'"]').click();
  const dialog=page.locator('.confirm-dialog');
  await expect(dialog).toContainText('Server'); await expect(dialog).toContainText('nas-01');
  await expect(dialog).toContainText('Scope'); await expect(dialog).toContainText('system');
  await expect(dialog).toContainText('Requires administrator password');
  expect(await radiusViolations(page)).toEqual([]); expect(await contrastViolations(page)).toEqual([]);
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  expect(await page.evaluate(() => window.__calls.filter(c=>c.cmd==='service_action').length)).toBe(0);
  await expect(action === 'disable' ? row.getByRole('button',{name:/More actions/}) : row.locator('[data-svc="'+action+'"]')).toBeFocused();
  if (action==='disable') await row.getByRole('button',{name:/More actions/}).click();
  await row.locator('[data-svc="'+action+'"]').click();
  await expect(dialog.locator('[type=submit]')).toHaveClass(action === 'restart' ? /primary/ : /danger/);
  await dialog.locator('[type=submit]').click();
  await expect(page.locator('#toast')).toContainText(name+' on nas-01');
  expect(await page.evaluate(() => window.__calls.filter(c=>c.cmd==='service_action').length)).toBe(1);
});

test('Overview links to the full Services list',async({page})=>{
  await nav(page,'Overview');await page.getByRole('button',{name:'View all services',exact:true}).click();
  await expect(page.locator('[data-state="all"]')).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('tbody tr:visible')).toHaveCount(16);
});

test('file, user and server cancellation never invokes a mutation', async ({ page }) => {
  await nav(page,'Files'); await expect(page.locator('#files-path')).toHaveValue('/');
  const file=page.locator('.files-row').first();
  await file.getByRole('button',{name:/More actions/}).click(); await file.getByRole('button',{name:'Delete',exact:true}).click();
  await expect(page.locator('.confirm-dialog')).toContainText('nas-01'); await page.locator('.confirm-dialog').getByText('Cancel',{exact:true}).click();
  await nav(page,'Users');
  const user=page.locator('#accounts-users tbody tr').filter({has:page.getByText('alice',{exact:true})});
  await user.getByRole('button',{name:/More actions/}).click(); await user.getByRole('button',{name:'Delete',exact:true}).click();
  await expect(page.locator('.confirm-dialog')).toContainText('nas-01'); await page.locator('.confirm-dialog').getByText('Cancel',{exact:true}).click();
  await page.locator('#manageServers').click(); await page.getByRole('button',{name:'Remove',exact:true}).first().click();
  await expect(page.locator('.confirm-dialog')).toContainText('Server'); await page.locator('.confirm-dialog').getByText('Cancel',{exact:true}).click();
  expect(await page.evaluate(() => window.__calls.filter(c=>['file_delete','account_action','profile_remove'].includes(c.cmd)).length)).toBe(0);
});

async function checkDialog(page) {
  expect(await radiusViolations(page)).toEqual([]); expect(await contrastViolations(page)).toEqual([]);
  for (const el of await page.locator('dialog[open] .field, dialog[open] button:enabled').all()) {
    await el.focus(); await page.keyboard.press('Shift');
    expect(await el.evaluate(e=>{const s=getComputedStyle(e);return s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>=2;})).toBe(true);
  }
}
test('settings, file naming, user forms and sudo share accessible dialog styles', async ({page})=>{
  await page.locator('#settingsBtn').click(); await checkDialog(page); await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await nav(page,'Files'); await expect(page.locator('#files-path')).toHaveValue('/');
  await page.getByRole('button',{name:'New file',exact:true}).click(); await checkDialog(page); await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await nav(page,'Users'); await page.getByRole('button',{name:'Add user',exact:true}).click(); await checkDialog(page);
  await page.getByLabel('User name',{exact:true}).fill('riley'); await page.getByRole('button',{name:'Create user',exact:true}).click();
  await expect(page.locator('.confirm-dialog')).toBeVisible(); await expect(page.locator('.confirm-dialog [type="submit"]')).toHaveText('Create user');
  await checkDialog(page); await page.getByRole('button',{name:'Cancel',exact:true}).click();
});

test('file and user count filters combine with search', async ({page})=>{
  await nav(page,'Files'); await expect(page.locator('#files-path')).toHaveValue('/');
  await page.locator('[data-file-kind="dir"]').click(); await expect(page.locator('.files-row:visible')).toHaveCount(1);
  await page.getByLabel('Search files',{exact:true}).fill('missing'); await expect(page.locator('.files-row:visible')).toHaveCount(0);
  await page.getByLabel('Search files',{exact:true}).fill(''); await page.locator('[data-file-kind="file"]').click(); await expect(page.locator('.files-row:visible')).toHaveCount(2);
  await nav(page,'Users'); await page.locator('[data-account-filter="sudo"]').click(); await expect(page.locator('#accounts-users tbody tr:visible')).toHaveCount(1);
  await page.getByLabel('Filter users',{exact:true}).fill('operator'); await expect(page.locator('#accounts-users tbody tr:visible')).toHaveCount(0);
});

test('a target change while confirmation is open cancels the service mutation', async ({page})=>{
  await nav(page,'Services'); await page.locator('[data-svc="stop"]').filter({visible:true}).first().click();
  await page.evaluate(async()=>{const {selectTarget}=await import('/state.js');selectTarget('other-testbox');});
  await page.locator('.confirm-dialog button.danger').click();
  expect(await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='service_action').length)).toBe(0);
});

test('error recovery retains old data, retries and opens the selected editor',async({page})=>{
  await page.evaluate(()=>{const invoke=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=(cmd,args)=>cmd==='query'&&args.what==='snapshot'?Promise.reject({kind:'timeout',message:'ssh: synthetic connection timed out'}):invoke(cmd,args);});
  await page.locator('#refresh').click();await expect(page.locator('.action-alert')).toContainText('ssh: synthetic connection timed out');
  await expect(page.locator('[data-freshness]')).toContainText('refresh failed');
  await page.locator('#refresh').click();await expect(page.locator('.action-alert')).toContainText('ssh: synthetic connection timed out');
  await nav(page,'Services');await nav(page,'Overview');await expect(page.locator('[data-freshness]')).toContainText('refresh failed');
  await page.locator('#manageServers').click();await page.getByRole('button',{name:'Edit',exact:true}).first().click();await expect(page.getByLabel('SSH target')).toHaveValue('nas-01');
});

test('recursive file deletion uses an explicit checkbox in the same confirm dialog', async ({page})=>{
  await nav(page,'Files'); await expect(page.locator('#files-path')).toHaveValue('/');
  const row=page.locator('.files-row').filter({has:page.getByText('documents',{exact:true})});
  await row.getByRole('button',{name:/More actions/}).click(); await row.getByRole('button',{name:'Delete',exact:true}).click();
  const dialog=page.locator('.confirm-dialog'); await expect(dialog).toContainText('Scope'); await expect(dialog).toContainText('/documents');
  await page.getByLabel('I confirm deleting this folder and all its contents recursively').check();
  await dialog.getByRole('button',{name:'Delete documents',exact:true}).click();
  await expect(row).toHaveCount(0);
  expect(await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='file_delete').map(c=>c.args.recursive))).toEqual([true]);
});
