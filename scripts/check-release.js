// Inspect only the frontend tree embedded by Tauri; never print matched values.
const fs = require('node:fs');
const path = require('node:path');

function inspect(file, bytes) {
  const findings = [];
  const fail = rule => findings.push({ file, rule });
  if (/(^|\/)(?:tests?|fixtures?|__mocks__|demo)(?:[\/._-]|$)/i.test(file)) fail('test/demo file');
  if (/(^|\/)\.env(?:\.|$)/i.test(file)) fail('environment file');
  if (/(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]+\.(?:pem|key|p12|pfx))$/i.test(file)) fail('key material filename');
  const text = bytes.toString('utf8');
  if (/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|PuTTY-User-Key-File-/i.test(text)) fail('private key');
  // Fonts are binary assets; third-party copyright/license notices must be preserved.
  if (/\.woff2?$|(?:^|\/)(?:LICENSE[^/]*|OFL\.txt)$/i.test(file)) return findings;
  if (/installDemoBackend|demoInvoke|demoHistory|__terminalEmit|tests\/fixtures|test-user-alias|NODESCAPE_TEST_HOST/.test(text)) fail('test/demo code');
  const reserved = domain => /(?:^|\.)(?:example|invalid|test|localhost)$|^(?:example\.(?:com|net|org))$/i.test(domain);
  if ([...text.matchAll(/[\w.+-]+@([a-z\d.-]+\.[a-z]{2,})/gi)].some(m => !reserved(m[1]))) fail('personal email or SSH destination');
  if ([...text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)].some(m => {
    const octets = m[0].split('.').map(Number);
    return octets.every(n => n <= 255) && !/^(?:0\.|127\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(m[0]) && m[0] !== '255.255.255.255';
  })) fail('non-documentation IP address');
  if ([...text.matchAll(/(?<![\w:])(?:[0-9a-f]{0,4}:){2,}[0-9a-f:.]*(?![\w:])/gi)].some(m =>
    require('node:net').isIP(m[0]) === 6 && !/^(?:::1?$|2001:db8:)/i.test(m[0])
  )) fail('non-documentation IPv6 address');
  if (/\/(?:home|Users)\/(?!test-user(?:[\/\s'"\x60]|$)|operator(?:[\/\s'"\x60]|$)|example(?:[\/\s'"\x60]|$))[\w.-]+|[A-Z]:[\\/]Users[\\/][\w.-]+/i.test(text)) fail('personal home path');
  return findings;
}
function scan(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = prefix + entry.name, full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) return [{ file, rule: 'symlink in shipping tree' }];
    return entry.isDirectory() ? scan(full, file + '/') : inspect(file, fs.readFileSync(full));
  });
}
if (require.main === module) {
  const findings = scan(path.join(__dirname, '../src'));
  if (findings.length) { console.error(JSON.stringify(findings, null, 2)); process.exitCode = 1; }
  else console.log('Release scan passed (src/ only).');
}
module.exports = { inspect, scan };
