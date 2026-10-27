import * as backend from './backend.js';
import { state, store, beginRequest, isCurrent, selectTarget, acceptSnapshot } from './state.js';
import { $, esc } from './ui/dom.js';
import { parseSnapshot } from './ui/parse.js';
import * as overview from './pages/overview.js';
import * as services from './pages/services.js';
import * as processes from './pages/processes.js';
import * as logs from './pages/logs.js';
import * as network from './pages/network.js';
import * as scheduled from './pages/scheduled.js';
import * as terminal from './pages/terminal.js';
import * as files from './pages/files.js';

const main = $('#main'), hostInput = $('#host');
const routes = {
  network: { page: network, load: target => backend.networkRead(target) },
  terminal: { page: terminal, load: async () => '' },
  files: { page: files, load: target => files.load(target) },
  overview: { page: overview, load: target => backend.query(target, 'snapshot'), snapshot: true },
  services: { page: services, load: target => backend.servicesRead(target) },
  processes: { page: processes, load: target => backend.query(target, 'processes') },
  logs: { page: logs, load: target => backend.logs(target, state.logUnit || null, state.logLines) },
  timers: { page: scheduled, load: target => backend.query(target, 'timers') },
};
let mounted;
function dispose() { mounted?.dispose?.(); mounted = null; }

async function refresh(fromTimer) {
  if (fromTimer === true && state.busy) return;
  const terminalChanged = terminal.targetChanged();
  if (state.view === 'terminal' && mounted === terminal && !terminalChanged) return;
  const request = beginRequest();
  if (!backend.available() || !state.host) {
    dispose();
    state.busy = false;
    $('#refresh').classList.remove('spin');
    main.innerHTML = !backend.available()
      ? '<div class="empty"><h1>NodeScape needs its desktop app to run</h1><p>Open NodeScape in its desktop app to connect to your servers.</p></div>'
      : '<div class="empty"><h1>Add a server</h1><p>Type an alias from your SSH config or <code>user@host</code> above. Choose your SSH config file in Settings.</p><p>NodeScape uses your system <code>ssh</code> with key auth (ssh-agent). Nothing is installed on the server.</p></div>';
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
    mounted.mount?.(main, { refresh });
    if (focused) main.querySelector('#' + focused)?.focus();
  } catch (error) {
    if (!isCurrent(request)) return;
    dispose();
    const host = request.target.host;
    const hostKey = error.kind === 'host_key_unknown' || error.kind === 'host_key_changed';
    main.innerHTML = `<div class="empty"><h1>Can't reach ${esc(host)}</h1><p class="error">${esc(error.message)}</p>
      <p>${hostKey
        ? `The server's host key isn't trusted yet, or it changed. NodeScape never accepts host keys on its own: connect once with <code>ssh ${esc(host)}</code> in a terminal and check the fingerprint.`
        : `Check that <code>ssh ${esc(host)}</code> works in a terminal without a password prompt.`}</p></div>`;
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
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  main.innerHTML = '';
  refresh();
}
$('#nav').addEventListener('click', e => {
  const view = e.target.closest('button')?.dataset.view;
  if (view) go(view);
});
main.addEventListener('click', e => {
  const ds = e.target.closest('button')?.dataset;
  if (ds?.go) go(ds.go);
  if (ds?.unit) { state.logUnit = ds.unit; go('logs'); }
});
$('#refresh').addEventListener('click', () => refresh());
hostInput.addEventListener('change', () => {
  const host = hostInput.value.trim();
  selectTarget(host);
  store('host', host);
  refresh();
});

let hostsGeneration = 0;
async function loadHosts() {
  const generation = ++hostsGeneration, config = state.config;
  if (!backend.available()) return;
  try {
    const hosts = await backend.hosts(config);
    if (generation === hostsGeneration && config === state.config) $('#hosts').innerHTML = hosts.map(h => `<option value="${esc(h)}">`).join('');
  } catch { /* A custom target can still be entered when no aliases are available. */ }
}
const dialog = $('#settings');
$('#settingsBtn').addEventListener('click', () => {
  $('#sshConfig').value = state.config || '';
  dialog.showModal();
});
dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'save') return;
  const config = $('#sshConfig').value.trim().replace(/^"(.*)"$/, '$1');
  store('sshConfig', config);
  selectTarget(state.host, config || null);
  loadHosts();
  refresh();
});
setInterval(() => state.live && state.view === 'overview' && refresh(true), 5000);
hostInput.value = state.host;
loadHosts();
refresh();
