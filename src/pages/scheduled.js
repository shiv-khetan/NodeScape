import { esc, head, stat, search, segTabs, dateTime } from '../ui/dom.js';
import { state } from '../state.js';
import { sections, words } from '../ui/parse.js';

export function render(txt) {
  const s = sections(txt);
  const timers = [];
  for (const l of s.timers || []) {
    const [k, ...v] = l.split('=');
    if (k === 'Id') timers.push({});
    if (timers.length) timers.at(-1)[k] = v.join('=');
  }
  const when = v => esc(dateTime(v));
  const cron = (s.cron || []).map(l => { const w = words(l); const n = w[0].startsWith('@') ? 1 : 5; return [w.slice(0, n).join(' '), w.slice(n).join(' ')]; });
  return head('Scheduled', esc(state.host)+' · systemd timers & crontab',search('schedule-filter','Search schedules').replace('type="search"','type="search" data-list-search'),segTabs('schedule','all',[['all','All '+(timers.length+cron.length)],['timers','Timers '+timers.length],['cron','Cron jobs '+cron.length]])) + `
  <section class="grid">
    <article class="card full">
      <div class="card-top"><h2>Timers</h2></div>
      <table><thead><tr><th>Timer</th><th>Runs</th><th>Next</th><th>Last</th><th>State</th></tr></thead><tbody>
      ${timers.map(t => `<tr><td><div class="who"><span class="ic ok">${esc((t.Id || '?')[0])}</span><div><p>${esc(t.Id)}</p></div></div></td><td><div class="acts runs"><button data-unit="${esc(t.Unit)}" title="Show logs">${esc(t.Unit)}</button></div></td><td class="num">${when(t.NextElapseUSecRealtime)}</td><td class="num muted">${when(t.LastTriggerUSec)}</td><td><span class="tag status ${t.ActiveState === 'active' ? 'ok' : ''}">${esc(t.ActiveState)}</span></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No timers found.</td></tr>'}
      </tbody></table>
    </article>
    <article class="card full">
      <div class="card-top"><h2>Crontab</h2><span class="muted">current user</span></div>
      ${cron.length ? `<table><thead><tr><th>Schedule</th><th>Command</th></tr></thead><tbody>${cron.map(([w, cmd]) => `<tr><td class="mono">${esc(w)}</td><td class="mono">${esc(cmd)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No crontab entries.</p>'}
    </article>
  </section>`;
}


let events;
export function mount(el) {
  events = new AbortController();
  el.addEventListener('click', event => {
    const button=event.target.closest('[data-schedule]'); if(!button)return;
    el.querySelectorAll('[data-schedule]').forEach(b=>{b.classList.toggle('on',b===button);b.setAttribute('aria-pressed',String(b===button));});
    const cards=el.querySelectorAll('.grid>.card'); cards[0].hidden=button.dataset.schedule==='cron';cards[1].hidden=button.dataset.schedule==='timers';
  },{signal:events.signal});
}
export function dispose(){events?.abort();}
