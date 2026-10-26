const path = require('path');
const { pathToFileURL } = require('url');
const { expect } = require('@playwright/test');

const APP = pathToFileURL(path.join(__dirname, '..', 'src', 'index.html')).href;

// The app ships everything it needs; block the network so no test can depend on it.
async function offline(page) {
  await page.route(/^https?:/, r => r.abort());
}

async function openDemo(page) {
  await offline(page);
  await page.goto(APP);
  await expect(page.locator('.hero h1')).toHaveText('Overview');
}

// Opens the app against a fake Tauri backend. `responses` maps a query name
// (snapshot/processes/timers) or command (logs/hosts/service_action) to the raw
// text the server would send, or to { error } to make the call fail.
// Every call is recorded in window.__calls.
async function openServer(page, responses) {
  await offline(page);
  await page.addInitScript(r => {
    if (!localStorage.getItem('host')) localStorage.setItem('host', 'testbox');
    window.__calls = [];
    window.__TAURI__ = {
      core: {
        invoke: async (cmd, args) => {
          window.__calls.push({ cmd, args });
          const v = r[cmd === 'query' ? args.what : cmd];
          if (v && v.error) throw v.error;
          return v ?? (cmd === 'hosts' ? [] : '');
        },
      },
    };
  }, responses);
  await page.goto(APP);
}

const nav = (page, name) => page.locator('#nav button', { hasText: name }).click();

module.exports = { APP, openDemo, openServer, nav };
