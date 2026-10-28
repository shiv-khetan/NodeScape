import { state } from '../state.js';
import { esc, head, stat, segTabs, ICON, search } from '../ui/dom.js';
import { parseLog, isErr, journalLimited } from '../ui/parse.js';

export function render(txt) {
  const { host, logUnit, logLines } = state;
  // Keep only real entries: drops journalctl's "Hint:" notice, "-- Boot … --" separators and "-- No entries --".
  const lines = txt.split('\n').filter(l => /^\d{4}-\d\d-\d\dT/.test(l));
  const limited = journalLimited(state.snap?.groups, txt);
  const access = state.snap?.groups?.length ? "Only this user's journal is visible" : `Only <b>${esc(host)}</b>'s own user journal is visible`;
  const errs = lines.filter(isErr).length;
  return head('Logs', esc(host)+' · '+(logUnit ? esc(logUnit) : 'all units')+' · '+lines.length+' lines', `
    ${search('logunit','Unit, e.g. nginx (blank = all)',logUnit)}
    ${segTabs('logstate','all',[['all','All '+lines.length],['errors','Errors '+errs]]).replace('data-logstate="errors" class="','data-logstate="errors" class="'+(errs ? 'has-errors ' : ''))}
    <button class="round dark" data-act="refresh" title="Load">${ICON.refresh}</button>`, '', segTabs('lines', logLines, [[100, '100'], [300, '300'], [1000, '1000']])) + `
  <section class="grid">
    ${limited ? `<article class="card full notice">${access}. Add the user to the <code>adm</code> or <code>systemd-journal</code> group to see system logs.</article>` : ''}
    <article class="card full"><div class="loglist">${lines.map(l => {
      const e = parseLog(l);
      return `<div class="logrow ${isErr(l) ? 'err' : ''}"><time>${esc(e.time)}</time><span class="tag">${esc(e.unit.replace(/\[\d+\]$/, '')) || 'log'}</span><span class="msg">${esc(e.msg)}</span></div>`;
    }).join('') || '<p class="muted">No log lines.</p>'}</div></article>
  </section>`;
}


let events;
export function mount(el, { refresh }) {
  events = new AbortController();
  const load = () => {
    state.logUnit = el.querySelector('#logunit').value.trim();
    refresh();
  };
  el.addEventListener('keydown', e => {
    if (e.target.id === 'logunit' && e.key === 'Enter') load();
  }, { signal: events.signal });
  el.addEventListener('click', e => {
    const ds = e.target.closest('button')?.dataset;
    if (ds?.logstate) {
      el.querySelectorAll('[data-logstate]').forEach(b => { b.classList.toggle('on', b === e.target.closest('button')); b.setAttribute('aria-pressed', String(b.classList.contains('on'))); });
      el.querySelectorAll('.logrow').forEach(r => { r.hidden = ds.logstate === 'errors' && !r.classList.contains('err'); });
    }
    if (ds?.lines) { state.logLines = +ds.lines; refresh(); }
    if (ds?.act === 'refresh') load();
  }, { signal: events.signal });
  const list = el.querySelector('.loglist');
  if (list) list.scrollTop = list.scrollHeight;
}
export function dispose() { events?.abort(); }
