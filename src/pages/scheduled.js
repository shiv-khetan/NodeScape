import { esc, head, stat } from '../ui/dom.js';
import { sections, words } from '../ui/parse.js';

export function render(txt) {
  const s = sections(txt);
  const timers = [];
  for (const l of s.timers || []) {
    const [k, ...v] = l.split('=');
    if (k === 'Id') timers.push({});
    if (timers.length) timers.at(-1)[k] = v.join('=');
  }
  const when = v => (v && v !== 'n/a' ? esc(v.replace(/:\d\d \w+$/, '')) : '—');
  const cron = (s.cron || []).map(l => { const w = words(l); const n = w[0].startsWith('@') ? 1 : 5; return [w.slice(0, n).join(' '), w.slice(n).join(' ')]; });
  return head('Scheduled', 'systemd timers & crontab') + `
  <section class="grid">
    <article class="card full"><div class="stats">${stat('Timers', timers.length, true)}${stat('Active', timers.filter(t => t.ActiveState === 'active').length)}${stat('Cron jobs', cron.length)}</div></article>
    <article class="card full">
      <div class="card-top"><h2>Timers</h2></div>
      <table><thead><tr><th>Timer</th><th>Runs</th><th>Next</th><th>Last</th><th>State</th></tr></thead><tbody>
      ${timers.map(t => `<tr><td><div class="who"><span class="ic ok">${esc((t.Id || '?')[0])}</span><div><p>${esc(t.Id)}</p></div></div></td><td><button class="pill" data-unit="${esc(t.Unit)}">${esc(t.Unit)}</button></td><td class="num">${when(t.NextElapseUSecRealtime)}</td><td class="num muted">${when(t.LastTriggerUSec)}</td><td><span class="tag ${t.ActiveState === 'active' ? 'ok' : ''}">${esc(t.ActiveState)}</span></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No timers found.</td></tr>'}
      </tbody></table>
    </article>
    <article class="card full">
      <div class="card-top"><h2>Crontab</h2><span class="muted">current user</span></div>
      <div class="loglist">${cron.map(([w, cmd]) => `<div class="logrow"><span class="tag ok">${esc(w)}</span><span class="msg mono">${esc(cmd)}</span></div>`).join('') || '<p class="muted">No crontab entries.</p>'}</div>
    </article>
  </section>`;
}

