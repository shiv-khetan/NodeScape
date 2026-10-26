const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('@playwright/test');
const APP = 'http://127.0.0.1:4174/';
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/demo-backend.js'), 'utf8');

async function offline(page) {
  await page.route(/^https?:/, route => new URL(route.request().url()).origin === new URL(APP).origin ? route.continue() : route.abort());
}
async function installBackend(page, options = {}) {
  await offline(page);
  await page.addInitScript({ content: fixture + '\nwindow.installDemoBackend(' + JSON.stringify(options) + ');' });
}
async function openDemo(page) {
  await installBackend(page);
  await page.goto(APP);
  await expect(page.locator('.hero h1')).toHaveText('Overview');
  // Collect genuine fixture samples so chart assertions cover populated charts.
  await page.locator('#refresh').click();
  await expect(page.locator('.step svg')).toBeVisible();
}
async function openServer(page, responses, host = 'testbox') {
  await installBackend(page, { responses, host });
  await page.goto(APP);
}
const nav = (page, name) => page.locator('#nav button', { hasText: name }).click();
module.exports = { APP, offline, installBackend, openDemo, openServer, nav };
