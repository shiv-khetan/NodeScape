import { esc, head, stat } from '../ui/dom.js';
import { words } from '../ui/parse.js';
import { dots } from '../ui/charts.js';

export function render(txt) {
  const ps = txt.trim().split('\n').filter(Boolean).map(l => { const [pid, user, cpu, mem, etime, ...cmd] = words(l); return { pid, user, cpu: +cpu, mem: +mem, etime, cmd: cmd.join(' ') }; });
  const top = ps[0] || { cmd: '—', cpu: 0 };
  const bar = (v, cls) => `<div class="mini"><div class="track"><i class="${cls}" style="width:${Math.min(100, v)}%"></i></div><span>${v.toFixed(1)}%</span></div>`;
  return head('Processes', `top ${ps.length} by CPU`) + `
  <section class="grid">
    <article class="card full">
      <div class="stats">${stat('Processes shown', ps.length, true)}${stat('CPU (sum)', ps.reduce((p, c) => p + c.cpu, 0).toFixed(1) + '%')}${stat('Memory (sum)', ps.reduce((p, c) => p + c.mem, 0).toFixed(1) + '%')}${stat('Busiest', esc(top.cmd))}</div>
    </article>
    <article class="card dotcard full">
      <div class="card-top"><h2>CPU by process</h2><span class="muted">top 14</span></div>
      <div class="dotrow"><b class="huge">${top.cpu.toFixed(1)}<small>%</small></b>${dots(ps.slice(0, 14).map(p => p.cpu), 'blue', v => v.toFixed(1) + '%')}<div class="vs"><span class="muted">busiest</span><b>${esc(top.cmd)}</b></div></div>
    </article>
    <article class="card full">
      <table><thead><tr><th>Process</th><th>PID</th><th>CPU</th><th>Memory</th><th>Running for</th></tr></thead><tbody>
      ${ps.map(p => `<tr><td><div class="who"><span class="ic">${esc(p.cmd[0])}</span><div><p>${esc(p.cmd)}</p><small>${esc(p.user)}</small></div></div></td><td class="num">${esc(p.pid)}</td><td>${bar(p.cpu, 'blue')}</td><td>${bar(p.mem, 'violet')}</td><td class="num">${esc(p.etime)}</td></tr>`).join('')}
      </tbody></table>
    </article>
  </section>`;
}

