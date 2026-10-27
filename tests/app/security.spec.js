const { test, expect } = require('./fixtures');
test.skip(process.platform !== 'win32', 'Real app tests require Windows WebView2');

test('fresh isolated app shows onboarding', async ({ app }) => {
  await expect(app.locator('.hero h1')).toHaveText('Add a server');
  await expect(app.getByRole('heading', { name: 'Check your environment' })).toBeVisible();
});

test('real IPC environment_check finds system SSH', async ({ app }) => {
  const result = await app.evaluate(async () => {
    const env = await window.__TAURI__.core.invoke('environment_check');
    // Return booleans so failures never print a personal executable path.
    return { hasPath: /(?:^|[\/\\])ssh(?:\.exe)?$/i.test(env.ssh.path), version: !!env.ssh.version, error: !!env.ssh.error };
  });
  expect(result).toEqual({ hasPath: true, version: true, error: false });
});

test('unlisted app command and ungranted plugin command are rejected', async ({ app }) => {
  const results = await app.evaluate(async () => {
    const rejected = async (command, args) => { try { await window.__TAURI__.core.invoke(command, args); return false; } catch { return true; } };
    return Promise.all([
      rejected('nodescape_unlisted_command', {}),
      rejected('plugin:dialog|message', { message: 'Must be denied' }),
      rejected('plugin:window|create', { options: { label: 'untrusted' } }),
    ]);
  });
  expect(results).toEqual([true, true, true]);
});

test('packaged CSP is present and injected inline scripts cannot run', async ({ app }) => {
  const response = await app.reload();
  const header = response?.headers()['content-security-policy'];
  const result = await app.evaluate(async header => {
    const policy = header || document.querySelector('meta[http-equiv="Content-Security-Policy" i]')?.content;
    const violations = [];
    document.addEventListener('securitypolicyviolation', event => violations.push(event.effectiveDirective));
    const script = document.createElement('script'); script.textContent = 'window.inlineRan = true'; document.head.append(script);
    await new Promise(resolve => setTimeout(resolve, 100));
    return { hasPolicy: !!policy, hasStrictScripts: /script-src[^;]*'self'/.test(policy || '') && !/unsafe-inline|unsafe-eval/.test((policy || '').match(/script-src[^;]*/)?.[0] || ''), ran: !!window.inlineRan, blocked: violations.includes('script-src-elem') };
  }, header);
  expect(result).toEqual({ hasPolicy: true, hasStrictScripts: true, ran: false, blocked: true });
});
