import { state } from '../state.js';
import { esc, head, stat, segTabs, ICON, search, plural } from '../ui/dom.js';
import { parseLog, isErr, journalLimited } from '../ui/parse.js';

export function render(txt) {
  const { host, logUnit, logLines } = state;
  // Keep only real entries: drops journalctl's "Hint:" notice, "-- Boot … --" separators and "-- No entries --".
  const lines = txt.split('\n').filter(l => /^\d{4}-\d\d-\d\dT/.test(l));
  const limited = journalLimited(state.snap?.groups, txt);
  const access = state.snap?.groups?.length ? "Only this user’s journal is visible" : `Only <b>${esc(host)}</b>’s own user journal is visible`;
  const errs = lines.filter(isErr).length;
  const units = [...new Set([...(state.snap?.units || []).map(u => u.unit), ...lines.map(l => parseLog(l).unit.replace(/\[\d+\]$/, ''))].filter(Boolean))].sort();
  let day = '';
  return head('Logs', esc(host)+' · '+(logUnit ? esc(logUnit) : 'all units')+' · '+plural(lines.length,'line'), `
    ${search('logunit','Filter by unit',logUnit).replace('<input ', '<input list="logunits" ')}<datalist id="logunits">${units.map(u => '<option value="' + esc(u) + '">').join('')}</datalist>
    ${search('logsearch','Search messages')}
    ${segTabs('logstate','all',[['all','All '+lines.length],['errors','Errors '+errs]]).replace('data-logstate="errors" class="','data-logstate="errors" class="'+(errs ? 'has-errors ' : ''))}
    ${segTabs('lines', logLines, [[100, '100 lines'], [300, '300 lines'], [1000, '1000 lines']])}
`) + `
  <section class="grid">
    ${limited ? `<article class="card full notice">${access}. Add the user to the <code>adm</code> or <code>systemd-journal</code> group to see system logs.</article>` : ''}
    <article class="card full"><div class="loglist">${lines.map(l => {
      const e = parseLog(l), date = l.slice(0, 10), separator = date === day ? '' : `<div class="logday" role="separator">${dayLabel(date)}</div>`;
      day = date;
      return separator + `<div class="logrow ${isErr(l) ? 'err' : ''}"><time>${esc(e.time)}</time><span class="tag">${esc(e.unit.replace(/\[\d+\]$/, '')) || 'log'}</span><span class="msg">${isErr(l) ? '<b class="sev">Error</b>' : ''}${esc(e.msg)}</span></div>`;
    }).join('') || '<p class="muted">No log lines.</p>'}</div></article>
  </section>`;
}

const dayLabel = date => new Date(date + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace(',', '');

// Rows show when they match both the errors toggle and the message search; a day separator shows if any of its rows do.
function filterRows(el) {
  const errorsOnly = el.querySelector('[data-logstate="errors"]')?.classList.contains('on');
  const q = el.querySelector('#logsearch')?.value.trim().toLowerCase() || '';
  let separator = null, any = false;
  const close = () => { if (separator) separator.hidden = !any; };
  for (const node of el.querySelectorAll('.loglist > *')) {
    if (node.classList.contains('logday')) { close(); separator = node; any = false; continue; }
    if (!node.classList.contains('logrow')) continue;
    node.hidden = (errorsOnly && !node.classList.contains('err')) || (q && !node.querySelector('.msg').textContent.toLowerCase().includes(q));
    any ||= !node.hidden;
  }
  close();
}

let events;
export function prepareRefresh(el) {
  const input = el.querySelector('#logunit');
  if (input) state.logUnit = input.value.trim();
}
export function mount(el, { refresh }) {
  events = new AbortController();
  const load = () => {
    const value = el.querySelector('#logunit').value.trim();
    if (value === state.logUnit) return;
    state.logUnit = value; refresh();
  };
  el.addEventListener('input', e => { if (e.target.id === 'logsearch') filterRows(el); }, { signal: events.signal });
  el.addEventListener('change', e => { if (e.target.id === 'logunit') load(); }, { signal: events.signal });
  el.addEventListener('focusout', e => { if (e.target.id === 'logunit') load(); }, { signal: events.signal });
  el.addEventListener('keydown', e => {
    if (e.target.id === 'logunit' && e.key === 'Enter') load();
  }, { signal: events.signal });
  el.addEventListener('click', e => {
    const ds = e.target.closest('button')?.dataset;
    if (ds?.logstate) {
      el.querySelectorAll('[data-logstate]').forEach(b => { b.classList.toggle('on', b === e.target.closest('button')); b.setAttribute('aria-pressed', String(b.classList.contains('on'))); });
      filterRows(el);
    }
    if (ds?.lines) { state.logLines = +ds.lines; refresh(); }

  }, { signal: events.signal });
  const list = el.querySelector('.loglist');
  if (list) list.scrollTop = list.scrollHeight;
}
export function dispose() { events?.abort(); }
