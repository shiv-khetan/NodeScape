import { state, currentTarget, requestContext, isCurrent } from '../state.js';
import { serviceAction } from '../backend.js';
import { withSudo } from '../ui/sudo.js';
import { esc, head, stat, svcClass, tag, segTabs, toast } from '../ui/dom.js';

let scope = 'system', scopeGeneration = 0, data, events, pending;
const unitState = u => u.active === 'failed' ? 'failed' : u.sub === 'running' ? 'running' : 'inactive';

export function render(d) {
  data = d;
  const { svcFilter, svcState } = state;
  const selected = d[scope], units = selected.units;
  const n = value => units.filter(u => unitState(u) === value).length;
  const rows = units.map(u => `
    <tr data-q="${esc((u.name + ' ' + u.description).toLowerCase())}" data-st="${unitState(u)}">
      <td><div class="who"><span class="ic ${svcClass(u)}">${esc(u.name[0])}</span><div><p>${esc(u.name)}</p><small>${esc(u.description)}</small>${u.load !== 'loaded' ? `<small class="service-load">${esc(u.load)}</small>` : ''}</div></div></td>
      <td>${tag(u)}</td>
      <td><span data-enabled>${esc(u.enabled)}</span></td>
      <td><div class="acts">
        ${['start', 'stop', 'restart', 'enable', 'disable'].map(a => `<button data-svc="${a}" data-u="${esc(u.name)}"${pending ? ' disabled' : ''}>${a}</button>`).join('')}
        ${scope === 'system' ? `<button data-unit="${esc(u.name)}">logs</button>` : ''}
      </div></td>
    </tr>`).join('');
  const available = scope === 'system' || selected.available;
  return head('Services', `${esc(state.host)} · systemd`, `<input class="field" id="filter" type="search" aria-label="Search services" placeholder="Search services…" value="${esc(svcFilter)}">`) + `
  <section class="grid services">
    <article class="card full">
      <div class="card-top"><h2>Service scope</h2>${segTabs('scope', scope, [['system', 'System'], ['user', 'User']])}</div>
      <p class="services-context">${scope === 'system' ? 'System services · actions may require administrator permission.' : 'Services owned by this SSH account · no administrator permission needed.'}</p>
      ${available ? `<div class="stats">${stat('Total units', units.length, true)}${stat('Running', n('running'))}${stat('Failed', n('failed'))}${stat('Inactive', n('inactive'))}</div>` : `<p id="services-unavailable" role="status">${esc(selected.reason || 'User manager unavailable for this SSH account.')}</p>`}
    </article>
    ${available ? `<article class="card full">
      <div class="card-top"><h2>All services</h2>${segTabs('state', svcState, [['all', 'All'], ['running', 'Running'], ['failed', 'Failed'], ['inactive', 'Inactive']])}</div>
      <table><colgroup><col class="service-unit"><col class="service-state"><col class="service-enabled"><col class="service-actions"></colgroup><thead><tr><th scope="col">Unit</th><th scope="col">State</th><th scope="col">Enabled</th><th scope="col"><span class="service-actions-label">Actions</span></th></tr></thead><tbody>${rows}</tbody></table>
      <p id="services-empty" class="services-context" hidden>No services match this filter.</p>
    </article>` : ''}
  </section>`;
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
    const target = currentTarget(), request = requestContext(), actionScope = scope, generation = scopeGeneration;
    const current = () => isCurrent(request) && scopeGeneration === generation;
    if (['stop', 'restart', 'disable'].includes(action) && !confirm(`${action} ${unit} on ${target.host} (${actionScope})?`)) return;
    const token = {};
    pending = token;
    el.querySelectorAll('[data-svc]').forEach(b => { b.disabled = true; });
    try {
      const run = password => {
        if (!current()) throw { kind: 'cancelled', message: 'Action cancelled' };
        return serviceAction(target, unit, action, password, actionScope);
      };
      await (actionScope === 'system' ? withSudo(run) : run());
      if (!current()) return;
      toast(`${action} ${unit}: ok`);
      refresh();
    } catch (err) {
      if (!current() || err.kind === 'cancelled') return;
      toast(err.message);
      if (err.kind === 'outcome_unknown') refresh();
    } finally {
      if (pending === token) {
        pending = null;
        el.querySelectorAll('[data-svc]').forEach(b => { b.disabled = false; });
      }
    }
  }, { signal: events.signal });
}
export function dispose() { events?.abort(); }
