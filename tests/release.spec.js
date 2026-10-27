const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('shipping src tree passes the release scan', () => {
  const { scan } = require('../scripts/check-release');
  expect(scan(path.join(__dirname, '../src'))).toEqual([]);
});

test('release scan rejects fixture/demo/env/key files and personal data without exposing values', () => {
  const { inspect } = require('../scripts/check-release');
  for (const file of ['tests/sample.js', 'fixtures/sample.json', 'demo-backend.js', '.env', '.env.local', 'id_ed25519', 'secret.pem']) {
    expect(inspect(file, Buffer.from('synthetic')).length, file).toBeGreaterThan(0);
  }
  for (const text of ['-----BEGIN OPENSSH PRIVATE KEY-----', 'window.installDemoBackend = () => {}',
    'person@personal-mail.net', '10.23.45.67', 'fd12:3456:789a::1', '/home/private-person/.ssh/config', 'C:\\Users\\PrivatePerson\\.ssh\\config']) {
    const findings = inspect('app.js', Buffer.from(text));
    expect(findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(findings)).not.toContain(text);
  }
  for (const text of ['operator@box.example', '192.0.2.10', '127.0.0.1', '0.0.0.0', '2001:db8::1', 'a::before { color: red; }', '/home/test-user/example', 'if (host !== \'demo\') {}']) {
    expect(inspect('app.js', Buffer.from(text))).toEqual([]);
  }
  expect(inspect('fonts/font.woff2', Buffer.from([0, 255, 10]))).toEqual([]);
});

test('config isolation override is compiled only in debug builds and shared by managed config', () => {
  const profiles = fs.readFileSync(path.join(__dirname, '../src-tauri/src/profiles.rs'), 'utf8');
  expect(profiles).toMatch(/#\[cfg\(debug_assertions\)\]\s*if let Some\(dir\) = std::env::var_os\("NODESCAPE_CONFIG_DIR"\)/);
  expect(fs.readFileSync(path.join(__dirname, '../src-tauri/src/ssh_config.rs'), 'utf8')).toContain('crate::profiles::config_dir(&app)?');
});

test('private key headers are rejected even in binary and license assets', () => {
  const { inspect } = require('../scripts/check-release');
  for (const file of ['fonts/font.woff2', 'vendor/LICENSE']) {
    expect(inspect(file, Buffer.from('-----BEGIN PRIVATE KEY-----')).length).toBeGreaterThan(0);
  }
});
