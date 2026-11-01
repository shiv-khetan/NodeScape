import * as backend from '../backend.js';
import { state } from '../state.js';
import { $, esc } from './dom.js';
// Fleet health: every saved server's status, so problems elsewhere show without switching.
// The current server is read from its live snapshot; the others get a cheap check every two minutes.
const health = new Map();
const CHECK_EVERY = 120_000;

const CONNECTION = { unreachable: 'unreachable', timeout: 'unreachable', connection_closed: 'unreachable',
  password_required: 'needs login', password_refused: 'needs login', auth_failed: 'needs login',
  host_key_unknown: 'host key', host_key_changed: 'host key', ssh_missing: 'no ssh' };

export const healthOf = id => health.get(id);
const fromCount = failed => failed ? { state: 'failed', text: failed + ' failed' } : { state: 'ok', text: 'healthy' };

function set(id, value) { health.set(id, value); render(); }

/** Live snapshot of the current server: count its failed units. */
export function fromSnapshot(snapshot) {
  const failed = snapshot.units.filter(u => u.active === 'failed').length;
  set(state.profileId, fromCount(failed));
}
/** A connection-level failure on the current server; page-specific errors leave health alone. */
export function fromError(error) {
  if (CONNECTION[error?.kind]) set(state.profileId, { state: 'warn', text: CONNECTION[error.kind] });
}

async function check(profile) {
  try {
    const { failed } = await backend.serverHealth({ host: profile.host, config: profile.config || null });
    set(profile.id, fromCount(failed));
  } catch (error) {
    set(profile.id, { state: 'warn', text: CONNECTION[error?.kind] || 'error' });
  }
}

export function checkFleet() {
  if (document.visibilityState === 'hidden') return;
  for (const profile of state.profiles) if (profile.id !== state.profileId) check(profile);
}

export function startFleet() {
  checkFleet();
  setInterval(checkFleet, CHECK_EVERY);
}

const dot = h => '<span class="health-dot ' + (h?.state || 'unknown') + '" aria-hidden="true"></span>';
/** Status cell for tables such as Manage servers; kept current by render(). */
export const statusCell = id => '<span data-health-cell="' + esc(id) + '">' + dot(health.get(id)) + esc(health.get(id)?.text || 'checking…') + '</span>';

export function render() {
  const hostbox = $('.hostbox'), current = health.get(state.profileId);
  if (current && current.state !== 'ok') hostbox.dataset.health = current.state; else delete hostbox.dataset.health;
  let list = $('.fleet');
  if (state.profiles.length < 2) { list?.remove(); return; }
  if (!list) {
    list = document.createElement('ul');
    list.className = 'fleet';
    list.setAttribute('aria-label', 'Server health');
    list.addEventListener('click', event => {
      const id = event.target.closest('[data-fleet]')?.dataset.fleet;
      const select = $('#host');
      if (id && id !== state.profileId) { select.value = id; select.dispatchEvent(new Event('change')); }
    });
    hostbox.after(list);
  }
  list.innerHTML = state.profiles.map(p => {
    const h = health.get(p.id);
    return '<li><button type="button" data-fleet="' + esc(p.id) + '"' + (p.id === state.profileId ? ' aria-current="true"' : '') + ' title="' + esc(p.name + ': ' + (h?.text || 'checking…')) + '">'
      + dot(h) + '<span class="fleet-name">' + esc(p.name) + '</span><span class="fleet-sum ' + (h?.state || '') + '">' + esc(h?.text || '…') + '</span></button></li>';
  }).join('');
  for (const cell of document.querySelectorAll('[data-health-cell]')) cell.outerHTML = statusCell(cell.dataset.healthCell);
}
