const { spawnSync } = require('node:child_process');
const path = require('node:path');
module.exports = () => {
  if (process.platform !== 'win32') return;
  const result = spawnSync(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), 'build', '--debug', '--no-bundle'], {
    cwd: path.join(__dirname, '../..'), windowsHide: true, encoding: 'utf8', timeout: 600000,
  });
  if (result.error || result.status !== 0) throw new Error('Debug app build failed; run npx tauri build --debug --no-bundle to diagnose.');
};
