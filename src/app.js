import * as backend from './backend.js';
import { state, store, beginRequest, isCurrent, selectProfile, acceptSnapshot } from './state.js';
import { initMenus } from './ui/menu.js';
import { cancelConfirm } from './ui/confirm.js';
import { $, esc } from './ui/dom.js';
import { errorAdvice, canOpenTerminal, hostKeyError, showError } from './ui/errors.js';
import { parseSnapshot } from './ui/parse.js';
import * as overview from './pages/overview.js';
import * as services from './pages/services.js';
import * as processes from './pages/processes.js';
import * as logs from './pages/logs.js';
import * as network from './pages/network.js';
import * as scheduled from './pages/scheduled.js';
import * as terminal from './pages/terminal.js';
import * as files from './pages/files.js';
import * as onboarding from './pages/onboarding.js';
import * as servers from './pages/servers.js';
import * as accounts from './pages/accounts.js';

initMenus();
const main = $('#main'), hostInput = $('#host');
const routes = {
  onboarding: { page: onboarding, load: async () => null },
  servers: { page: servers, load: async () => null },
  accounts: { page: accounts, load: target => accounts.load(target) },
  network: { page: network, load: target => backend.networkRead(target) },
  terminal: { page: terminal, load: async () => '' },
  files: { page: files, load: target => files.load(target) },
  overview: { page: overview, load: target => backend.query(target, 'snapshot'), snapshot: true },
  services: { page: services, load: target => backend.servicesRead(target) },
  processes: { page: processes, load: target => backend.query(target, 'processes') },
  logs: { page: logs, load: target => backend.logs(target, state.logUnit || null, state.logLines) },
  timers: { page: scheduled, load: target => backend.query(target, 'timers') },
};
function updateNavigation(view) {
  document.querySelectorAll('.sidebar button').forEach(button => {
    const route = button.dataset.view || ({addServer:'onboarding',manageServers:'servers'}[button.id]);
    if (button.dataset.view) { const disabled = backend.available() && !state.profiles.length; button.disabled = disabled; button.setAttribute('aria-disabled', String(disabled)); }
    const selected = route === view;
    button.classList.toggle('on', selected);
    if (selected) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
  });
}
let mounted;
function dispose() { cancelConfirm(); mounted?.dispose?.(); mounted = null; }

async function refresh(fromTimer) {
  if (fromTimer === true && (state.busy || document.querySelector('.confirm-dialog[open]'))) return;
  if (mounted === logs) logs.prepareRefresh(main);
  if (!state.host && state.view !== 'servers') state.view = 'onboarding';
  updateNavigation(state.view);
  const terminalChanged = terminal.targetChanged();
  if (state.view === 'terminal' && mounted === terminal && !terminalChanged) return;
  const request = beginRequest();
  if (!backend.available()) {
    dispose();
    state.busy = false;
    $('#refresh').classList.remove('spin');
    main.innerHTML = '<div class="empty"><h1>NodeScape needs its desktop app to run</h1><p>Open NodeScape in its desktop app to connect to your servers.</p></div>';
    return;
  }
  state.busy = true;
  $('#refresh').classList.add('spin');
  const route = routes[request.view];
  try {
    const text = await route.load(request.target);
    // Reject stale reads before parsing or touching snapshots and chart history.
    if (!isCurrent(request)) return;
    const data = route.snapshot ? parseSnapshot(text, request.target.host) : text;
    if (route.snapshot) acceptSnapshot(request, data);
    const focused = document.activeElement?.id;
    dispose();
    main.innerHTML = route.page.render(data);
    mounted = route.page;
    mounted.mount?.(main, { refresh, go, profilesChanged });
    if (focused) main.querySelector('#' + focused)?.focus();
  } catch (error) {
    if (!isCurrent(request)) return;
    dispose();
    const host = request.target.host;
    if (request.view === 'overview' && state.snap) {
      state.snapshotError = error;
      main.innerHTML = overview.render(state.snap);
      mounted = overview;
      overview.mount(main, { refresh, go, profilesChanged });
      showError(error, main, host);
    } else {
      updateNavigation(null);
      main.innerHTML = '<div class="empty"><h1>Can\'t reach ' + esc(host) + '</h1><pre class="error" role="alert">' + esc(error.message) + '</pre><p>' + esc(errorAdvice(error, host) || 'Check that ssh ' + host + ' works in a terminal without a password prompt.') + '</p><div class="dlg-actions"><button class="primary" data-retry>Retry</button><button data-edit-server>Edit server</button>' + (hostKeyError(error) ? '<button data-approve-host>Approve host key</button>' : '') + (canOpenTerminal(error) ? '<button data-go="terminal">Open terminal</button>' : '') + '</div></div>';
      main.querySelector('[data-retry]').onclick = () => refresh();
      main.querySelector('[data-edit-server]').onclick = () => { state.editServer = state.profileId; go('servers'); };
    }

  } finally {
    if (isCurrent(request)) {
      state.busy = false;
      $('#refresh').classList.remove('spin');
    }
  }
}
function go(view) {
  if (!routes[view]) return;
  dispose();
  state.view = view;
  updateNavigation(view);
  main.innerHTML = '';
  refresh();
}
$('#nav').addEventListener('click', e => {
  const view = e.target.closest('button')?.dataset.view;
  if (view) go(view);
});
main.addEventListener('click', e => {
  const ds = e.target.closest('button')?.dataset;
  if (ds && 'approveHost' in ds) { state.trustProfile = state.profiles.find(p => p.id === state.profileId); go('onboarding'); return; }
  if (ds?.serviceFilter) { state.svcState = ds.serviceFilter; state.svcFilter = ''; }
  if (ds?.go) go(ds.go);
  if (ds?.unit) { state.logUnit = ds.unit; go('logs'); }
});
main.addEventListener('input', e => {
  if (!e.target.matches('[data-list-search]')) return;
  const q = e.target.value.toLowerCase();
  main.querySelectorAll('tbody tr, .logrow').forEach(row => { row.hidden = !row.textContent.toLowerCase().includes(q); });
});
$('#refresh').addEventListener('click', () => refresh());
hostInput.addEventListener('change', () => {
  selectProfile(state.profiles.find(p => p.id === hostInput.value));
  terminal.targetChanged();
  go(state.profileId ? (['onboarding','servers'].includes(state.view) ? 'overview' : state.view) : 'onboarding');
});
$('#addServer').addEventListener('click', () => go('onboarding'));
$('#manageServers').addEventListener('click', () => go('servers'));
async function loadProfiles() {
  const result = await backend.profilesList();
  state.profiles = result.profiles;
  state.profileWarning = result.warning || '';
  hostInput.innerHTML = '<option value="">Select a server</option>' + state.profiles.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('');
}
async function profilesChanged(profile, open = false) {
  await loadProfiles();
  const selected = state.profiles.find(p => p.id === (open ? profile?.id : state.profileId)) || state.profiles[0];
  selectProfile(selected); hostInput.value = state.profileId;
  terminal.targetChanged();
  go(open ? 'overview' : 'servers');
}
const dialog = $('#settings');
$('#settingsBtn').addEventListener('click', () => {
  $('#sshConfig').value = state.defaultConfig || '';
  dialog.showModal();
});
dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'save') return;
  state.defaultConfig = $('#sshConfig').value.trim().replace(/^"(.*)"$/, '$1') || null;
  store('defaultSshConfig', state.defaultConfig || '');
});
async function start() {
  if (!backend.available()) { refresh(); return; }
  try {
    await loadProfiles();
    if (store('profilesMigrated') !== '1') {
      const host = store('host');
      if (!state.profiles.length && host && host !== 'demo') {
        await backend.profileSave({id:'',name:host,host,config:store('sshConfig') || null});
        await loadProfiles();
      }
      store('profilesMigrated', '1');
    }
    selectProfile(state.profiles.find(p => p.id === store('selectedProfile')) || state.profiles[0]);
    hostInput.value = state.profileId;
    refresh();
  } catch (error) {
    main.innerHTML = '<div class="empty"><h1>Saved servers could not be loaded</h1><p class="error">' + esc(error.kind + ': ' + error.message) + '</p><button class="pill" data-start-retry>Try again</button></div>';
    main.querySelector('[data-start-retry]').onclick = start;
  }
}
setInterval(() => state.live && state.view === 'overview' && refresh(true), 5000);
start();
