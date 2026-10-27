const { test, expect } = require('@playwright/test');
const { APP, installBackend, openDemo, nav } = require('./helpers');
const calls = (page, cmd) => page.evaluate(cmd => window.__calls.filter(c => c.cmd === cmd), cmd);
async function open(page) { await openDemo(page); await nav(page, 'Terminal'); await expect(page.locator('[data-terminal-status]')).toHaveText('Connected'); }

test('open, input round trip and acknowledge after writing', async ({ page }) => {
  await open(page);
  const [opened] = await calls(page, 'terminal_open');
  expect(opened.args.target.host).toBe('nas-01');
  expect(opened.args.cols).toBeGreaterThan(2);
  await page.locator('.xterm-helper-textarea').pressSequentially('echo ');
  await page.locator('.xterm-helper-textarea').evaluate(el => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'café 漢');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await page.locator('.xterm-helper-textarea').press('Enter');
  await expect.poll(async () => (await calls(page, 'terminal_input')).map(c => c.args.data).join('')).toContain('café 漢\r');
  await expect(page.locator('.xterm-rows')).toContainText('café 漢');
  await expect.poll(async () => (await calls(page, 'terminal_ack')).reduce((n, c) => n + c.args.bytes, 0)).toBeGreaterThan(0);
});

test('resize sends fitted dimensions', async ({ page }) => {
  await open(page);
  await page.setViewportSize({ width: 800, height: 600 });
  await expect.poll(async () => (await calls(page, 'terminal_resize')).length).toBeGreaterThan(0);
  const small = (await calls(page, 'terminal_resize')).at(-1).args;
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect.poll(async () => (await calls(page, 'terminal_resize')).at(-1).args.cols).toBeGreaterThan(small.cols);
  expect((await calls(page, 'terminal_resize')).at(-1).args.rows).toBeGreaterThan(small.rows);
});

test('disconnect and reconnect create one fresh session', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.locator('[data-terminal-status]')).toHaveText('Disconnected');
  expect(await calls(page, 'terminal_close')).toHaveLength(1);
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page.locator('[data-terminal-status]')).toHaveText('Connected');
  expect(await calls(page, 'terminal_open')).toHaveLength(2);
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'terminal_open')).length).toBe(3);
  expect(await calls(page, 'terminal_close')).toHaveLength(2);
});

test('page switches preserve session and hidden output', async ({ page }) => {
  await open(page);
  await nav(page, 'Services');
  await page.evaluate(() => window.__terminalEmit('terminal-1', 'HIDDEN café 漢\r\n'));
  await expect.poll(async () => (await calls(page, 'terminal_ack')).length).toBeGreaterThan(1);
  await nav(page, 'Terminal');
  await expect(page.locator('.xterm-rows')).toContainText('HIDDEN café 漢');
  expect(await calls(page, 'terminal_open')).toHaveLength(1);
  expect(await calls(page, 'terminal_close')).toHaveLength(0);
  await page.locator('#refresh').click();
  await expect(page.locator('[data-terminal-status]')).toHaveText('Connected');
  expect(await calls(page, 'terminal_open')).toHaveLength(1);
});

test('server and config switches close sessions even on another page', async ({ page }) => {
  await open(page);
  await nav(page, 'Services');
  await page.locator('#host').selectOption('testbox');

  await expect.poll(async () => (await calls(page, 'terminal_close')).length).toBe(1);
  await nav(page, 'Terminal');
  await expect(page.locator('[data-terminal-status]')).toHaveText('Connected');
  expect((await calls(page, 'terminal_open')).at(-1).args.target.host).toBe('testbox');
  await page.getByRole('button', {name:'Manage servers',exact:true}).click();
  await page.locator('[data-server-row]').filter({has:page.locator('.who p',{hasText:'testbox'})}).getByRole('button',{name:'Edit',exact:true}).click();
  await page.getByLabel('SSH config file',{exact:true}).fill('C:/test config');
  await page.getByRole('button',{name:'Save changes'}).click();
  await expect.poll(async () => (await calls(page, 'terminal_close')).length).toBe(2);
});

test('remote output and typed errors are text and exits allow reconnect', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__terminalEmit('terminal-1', '<img src=x onerror="window.pwned=1">\r\n\u001b]52;c;ZXZpbA==\u0007'));
  await expect(page.locator('.xterm-rows')).toContainText('<img');
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  expect(await page.locator('.terminal-card img').count()).toBe(0);
  await page.evaluate(() => window.__terminalExit('terminal-1', 255));
  await expect(page.locator('[data-terminal-status]')).toHaveText('Exited (255)');
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page.locator('[data-terminal-status]')).toHaveText('Connected');
});

test('open failures remain visible and escaped', async ({ page }) => {
  await installBackend(page, { responses: { terminal_open: { error: { kind: 'host_key_unknown', message: '<b>Untrusted key</b>' } } } });
  await page.goto(APP); await nav(page, 'Terminal');
  await expect(page.locator('[data-terminal-error]')).toHaveText('<b>Untrusted key</b>');
  expect(await page.locator('[data-terminal-error] b').count()).toBe(0);
  await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeEnabled();
});

for (const [width, height] of [[800,600],[1024,768],[1280,800],[1440,900],[1920,1080],[2560,1440]]) {
  test('terminal fits '+width+'x'+height, async ({ page }) => {
    await page.setViewportSize({ width, height }); await open(page);
    await expect.poll(() => page.evaluate(() => {
      const card = document.querySelector('.terminal-card'), term = document.querySelector('[data-terminal-screen]');
      const rect = card.getBoundingClientRect(), screen = term.getBoundingClientRect();
      return document.documentElement.scrollWidth <= innerWidth + 1 && card.scrollWidth <= card.clientWidth + 1 && rect.bottom <= innerHeight + 1 && screen.height > 200 && screen.right <= rect.right;
    })).toBe(true);
  });
}


test('switching target while open is pending closes the late session', async ({ page }) => {
  await installBackend(page, { responses: { terminal_open: { defer: true } } });
  await page.goto(APP); await nav(page, 'Terminal');
  await expect.poll(() => page.evaluate(() => window.__pending.length)).toBe(1);
  await nav(page, 'Services');
  await page.locator('#host').selectOption('testbox');
  await page.evaluate(() => window.__pending.shift()());
  await expect.poll(async () => (await calls(page, 'terminal_close')).length).toBe(1);
  await expect(page.locator('.hero h1')).toHaveText('Services');
});
