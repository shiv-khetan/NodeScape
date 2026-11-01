import { state, currentTarget, requestContext, isCurrent } from '../state.js';
import { adminRow, fillAdminNote } from '../ui/admin.js';
import { serviceAction } from '../backend.js';
import { runAction } from '../ui/confirm.js';
import { rowMenu } from '../ui/menu.js';
import { showError } from '../ui/errors.js';
import { esc, head, tag, segTabs, toast, search, plural } from '../ui/dom.js';

let scope = 'system', scopeGeneration = 0, data, events, pending;
const unitState = u => u.active === 'failed' ? 'failed' : u.sub === 'running' ? 'running' : 'inactive';

export function render(d) {
  data = d;
  const { svcFilter, svcState } = state;
  const selected = d[scope], units = selected.units;
  const n = value => units.filter(u => unitState(u) === value).length;
  const actionButton = (u, a) => `<button data-svc="${a}" data-u="${esc(u.name)}" class="${['stop','disable'].includes(a) ? 'destructive' : ''}"${pending ? ' disabled' : ''}>${a[0].toUpperCase()+a.slice(1)}</button>`;
  const rows = [...units].sort((a,b) => Number(unitState(b) === 'failed') - Number(unitState(a) === 'failed')).map(u => {
    const st = unitState(u);
    const visible = st === 'running' ? ['restart','stop'] : st === 'failed' ? ['restart'] : ['start'];
    const logs = scope === 'system' ? `<button data-unit="${esc(u.name)}">Logs</button>` : '';
    const valid = [...(st === 'running' ? ['restart','stop'] : st === 'failed' ? ['start','restart'] : ['start']), ...(u.enabled === 'enabled' || u.enabled === 'enabled-runtime' ? ['disable'] : u.enabled === 'disabled' ? ['enable'] : [])];
    const menu = valid.filter(a => !visible.includes(a)).map(a => actionButton(u,a)).join('') + (st === 'failed' ? '' : logs);
    return `<tr data-q="${esc((u.name + ' ' + u.description).toLowerCase())}" data-st="${st}"><td><div class="who"><div><p>${esc(u.name)}</p><small title="${esc(u.description)}">${esc(u.description)}</small>${u.load !== 'loaded' ? `<small class="service-load">${esc(u.load)}</small>` : ''}</div></div></td><td>${tag(u)}</td><td><span data-enabled>${esc(u.enabled)}</span></td><td><div class="acts">${visible.map(a => actionButton(u,a)).join('')}${st === 'failed' ? logs : ''}${rowMenu(u.name,menu)}</div></td></tr>`;
  }).join('');
  const available = scope === 'system' || selected.available;
  const counts = segTabs('state', svcState, [['all', 'All '+units.length], ['running', 'Running '+n('running')], ['failed', 'Failed '+n('failed')], ['inactive', 'Inactive '+n('inactive')]]).replace('data-state="failed" class="','data-state="failed" class="'+(n('failed') ? 'has-errors ' : ''));
  return head('Services', `${esc(state.host)} · systemd · ${plural(units.length, 'unit')}`, search('filter','Search services',svcFilter), counts + segTabs('scope',scope,[['system','System'],['user','User']])) + `<section class="grid services">${available ? `<article class="card full"><div class="card-top"><h2>Units</h2><span class="muted">${scope === 'system' ? 'System services · <span class="admin-note">actions may require administrator permission</span>' : 'Services owned by this SSH account · no administrator permission needed.'}</span></div><table><colgroup><col class="service-unit"><col class="service-state"><col class="service-enabled"><col class="service-actions"></colgroup><thead><tr><th scope="col">Unit</th><th scope="col">State</th><th scope="col">Enabled</th><th scope="col" class="service-actions-label">Actions</th></tr></thead><tbody>${rows}</tbody></table><p id="services-empty" class="services-context" hidden>No services match this filter.</p></article>` : `<p id="services-unavailable" role="status">${esc(selected.reason || 'User manager unavailable for this SSH account.')}</p>`}</section>`;
}

function applyFilter(el) {
  const q = state.svcFilter.toLowerCase();
  let visible = 0;
  el.querySelectorAll('tbody tr').forEach(r => {
    r.hidden = (!!q && !r.dataset.q.includes(q)) || (state.svcState !== 'all' && r.dataset.st !== state.svcState);
    if (!r.hidden) visible++;
  });
  const empty = el.querySelector('#services-empty');
  if (empty) empty.hidden = visible > 0;
}

export function mount(el, { refresh }) {
  fillAdminNote(el, currentTarget());
  events = new AbortController();
  applyFilter(el);
  el.querySelectorAll('[data-state], [data-scope]').forEach(b => b.setAttribute('aria-pressed', String(b.classList.contains('on'))));
  el.addEventListener('input', e => {
    if (e.target.id === 'filter') { state.svcFilter = e.target.value; applyFilter(el); }
  }, { signal: events.signal });
  el.addEventListener('click', async e => {
    const button = e.target.closest('button');
    if (!button) return;
    const { state: filter, svc: action, u: unit, scope: nextScope } = button.dataset;
    if (nextScope && nextScope !== scope) {
      scope = nextScope;
      scopeGeneration++;
      dispose();
      el.innerHTML = render(data);
      mount(el, { refresh });
      el.querySelector('[data-scope="' + scope + '"]').focus();
      return;
    }
    if (filter) {
      state.svcState = filter;
      el.querySelectorAll('[data-state]').forEach(b => {
        b.classList.toggle('on', b === button);
        b.setAttribute('aria-pressed', String(b === button));
      });
      applyFilter(el);
    }
    if (!action || pending) return;
    const generation = scopeGeneration;
    await performServiceAction(el, action, unit, scope, refresh, () => scopeGeneration === generation);

  }, { signal: events.signal });
}
export function dispose() { events?.abort(); }

// Units that can carry the SSH session itself: stopping or disabling them can lock the user out of a headless box.
export const carriesConnection = unit => /^(sshd?|tailscaled|NetworkManager|systemd-networkd|networking|nftables|ufw|firewalld|iptables|wpa_supplicant)(@[^.]*)?\.(service|socket)$/.test(unit);

export async function performServiceAction(el, action, unit, actionScope, refresh, scopeCurrent = () => true) {
  if (pending) return;
  const target = currentTarget(), request = requestContext();
  const current = () => isCurrent(request) && scopeCurrent();
  const verb = action[0].toUpperCase() + action.slice(1), token = {};
  pending = token;
  el.querySelectorAll('[data-svc]').forEach(b => { b.disabled = true; });
  const server = state.profiles.find(p => p.id === state.profileId)?.name || target.host;
  const lockout = actionScope === 'system' && ['stop','disable'].includes(action) && carriesConnection(unit);
  try {
    const result = await runAction({ verb, object: unit, server,
      scope: actionScope, password: actionScope === 'system' ? adminRow(target) : 'No',
      confirm: ['stop','restart','disable'].includes(action), allowSudo: actionScope === 'system',
      destructive: ['stop','disable'].includes(action),
      checks: lockout ? [{ id: 'lockout-ack', label: 'I have another way into ' + server, required: true }] : [],
      explanation: lockout ? "You may be connected to " + server + " through " + unit + ". " + (action === 'stop' ? "Stopping it can end NodeScape’s connection" : "Disabling it means it won’t start after a reboot, which can end NodeScape’s connection") + ", and you may need physical access to recover. Restart is safer if you only need to reload it." : {start:'The service will start now.',enable:'The service will start automatically at boot.',stop:'The service will stop until it is started again.',restart:'The service will briefly stop while it restarts.',disable:'The service will no longer start automatically.'}[action],
      run: password => {
        if (!current()) throw { kind: 'cancelled', message: 'Action cancelled' };
        return serviceAction(target, unit, action, actionScope === 'system' ? password : undefined, actionScope);
      },
    });
    if (!result || !current()) return;
    toast(({start:'Started',stop:'Stopped',restart:'Restarted',enable:'Enabled',disable:'Disabled'}[action]) + ' ' + unit + ' on ' + target.host);
    await refresh();
  } catch (error) {
    if (!current() || error.kind === 'cancelled') return;
    if (error.kind === 'outcome_unknown') await refresh();
    showError(error, el, target.host);
  } finally {
    if (pending === token) { pending = null; el.querySelectorAll('[data-svc]').forEach(b => { b.disabled = false; }); }
  }
}
