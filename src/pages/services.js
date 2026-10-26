import { state, currentTarget, requestContext, isCurrent } from '../state.js';
import { serviceAction } from '../backend.js';
import { withSudo } from '../ui/sudo.js';
import { esc, head, stat, svcClass, tag, segTabs, toast } from '../ui/dom.js';

export function render(d) {
  const { svcFilter, svcState } = state;
  const n = s => d.units.filter(u => (s === 'failed' ? u.active === 'failed' : s === 'running' ? u.sub === 'running' : u.active === 'inactive')).length;
  const rows = d.units.map(u => `
    <tr data-q="${esc((u.unit + ' ' + u.desc).toLowerCase())}" data-st="${u.active === 'failed' ? 'failed' : u.sub === 'running' ? 'running' : 'inactive'}">
      <td><div class="who"><span class="ic ${svcClass(u)}">${esc(u.unit[0])}</span><div><p>${esc(u.unit)}</p><small>${esc(u.desc)}</small></div></div></td>
      <td>${tag(u)}</td>
      <td><div class="acts">
        ${['start', 'stop', 'restart'].map(a => `<button data-svc="${a}" data-u="${esc(u.unit)}">${a}</button>`).join('')}
        <button data-unit="${esc(u.unit)}">logs</button>
      </div></td>
    </tr>`).join('');
  return head('Services', `${esc(d.host)} · systemd`, `<input class="field" id="filter" placeholder="Search services…" value="${esc(svcFilter)}">`) + `
  <section class="grid">
    <article class="card full">
      <div class="stats">${stat('Total units', d.units.length, true)}${stat('Running', n('running'))}${stat('Failed', n('failed'))}${stat('Inactive', n('inactive'))}</div>
    </article>
    <article class="card full">
      <div class="card-top"><h2>All services</h2>${segTabs('state', svcState, [['all', 'All'], ['running', 'Running'], ['failed', 'Failed'], ['inactive', 'Inactive']])}</div>
      <table><thead><tr><th>Unit</th><th>State</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    </article>
  </section>`;
}

function applyFilter(el) {
  const q = state.svcFilter.toLowerCase();
  el.querySelectorAll('tbody tr').forEach(r => (r.hidden = (!!q && !r.dataset.q.includes(q)) || (state.svcState !== 'all' && r.dataset.st !== state.svcState)));
}
let events;
export function mount(el, { refresh }) {
  events = new AbortController();
  applyFilter(el);
  el.addEventListener('input', e => {
    if (e.target.id === 'filter') { state.svcFilter = e.target.value; applyFilter(el); }
  }, { signal: events.signal });
  el.addEventListener('click', async e => {
    const button = e.target.closest('button');
    if (!button) return;
    const { state: filter, svc: action, u: unit } = button.dataset;
    if (filter) {
      state.svcState = filter;
      el.querySelectorAll('[data-state]').forEach(b => b.classList.toggle('on', b === button));
      applyFilter(el);
    }
    if (!action) return;
    const target = currentTarget(), request = requestContext();
    if (action !== 'start' && !confirm(`${action} ${unit} on ${target.host}?`)) return;
    button.disabled = true;
    try {
      await withSudo(password => {
        if (!isCurrent(request)) throw { kind: 'cancelled', message: 'Action cancelled' };
        return serviceAction(target, unit, action, password);
      });
      if (!isCurrent(request)) return;
      toast(`${action} ${unit}: ok`);
      refresh();
    } catch (err) {
      if (isCurrent(request) && err.kind !== 'cancelled') toast(err.message);
    } finally {
      button.disabled = false;
    }
  }, { signal: events.signal });
}
export function dispose() { events?.abort(); }
