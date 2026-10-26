import { state, history } from '../state.js';
import { pct, avg, gib, rate, uptime, esc, stat, svcClass, tag, ICON } from '../ui/dom.js';
import { parseLog, isErr } from '../ui/parse.js';
import { bars, gauge, stepChart, dotCard } from '../ui/charts.js';

export function render(d) {
  const hist = history(), { host, live } = state;
  const [total, , free, , , avail] = d.mem;
  const used = pct(total - avail, total), fr = pct(free, total), ca = Math.max(0, 100 - used - fr);
  const running = d.units.filter(u => u.sub === 'running');
  const failed = d.units.filter(u => u.active === 'failed');
  const loadPct = Math.min(100, pct(d.load[0], d.cpus));
  const top = [...failed, ...running].slice(0, 6);
  const meters = [['Swap', d.swap[1], d.swap[0]], ...[...d.disks].sort((x, y) => y.size - x.size).slice(0, 3).map(x => [x.target, x.used, x.size])].filter(m => m[2]);
  const stripes = ['violet', 'blue', 'green', 'pink'];

  return `
  <section class="hero">
    <h1>Overview</h1>
    <span class="hostchip" title="${esc(d.os)}">${esc(d.host)} · ${esc(d.ip || host)}</span>
    <div class="toolbar">
      <span class="tag ok">${running.length} running</span>
      <span class="tag ${failed.length ? 'bad' : ''}">${failed.length} failed</span>
      <button class="tbtn" data-act="live" aria-pressed="${live}">${live ? ICON.pause + ' Live' : ICON.play + ' Paused'}</button>
    </div>
  </section>

  <section class="grid">
    <article class="card cpu">
      <div class="card-top"><h2>CPU</h2><button class="round" data-go="processes" title="Processes">${ICON.arrow}</button></div>
      <div class="stats">
        ${stat('Usage now', Math.round(d.cpu) + '%', true)}${stat('Load 1m', d.load[0].toFixed(2))}${stat('Load 5m', d.load[1].toFixed(2))}${stat('Load 15m', d.load[2].toFixed(2))}${stat('Cores', d.cpus)}
      </div>
      ${bars(hist.cpu)}
    </article>

    <article class="card">
      <div class="card-top"><h2>Load</h2><button class="round" data-act="refresh" title="Refresh now">${ICON.refresh}</button></div>
      ${gauge(loadPct, d.load[0], d.cpus)}
    </article>

    <article class="card">
      <div class="card-top"><h2>Memory</h2><span class="muted">${gib(total)} total</span></div>
      <div class="bignum"><b>${gib(total - avail)}</b><span class="badge">${used}%</span></div>
      <span class="muted">used · ${ca}% cache · ${fr}% free</span>
      ${meters.map((m, i) => `<div class="meter"><div><span>${esc(m[0])}</span><b>${pct(m[1], m[2])}% of ${gib(m[2])}</b></div><div class="track"><i class="${stripes[i % 4]}" style="width:${pct(m[1], m[2])}%"></i></div></div>`).join('')}
    </article>

    <article class="card history">
      <div class="card-top"><h2>CPU history</h2><span class="muted">avg ${avg(hist.cpu).toFixed(0)}%</span></div>
      ${stepChart(hist.cpu.slice(-20))}
    </article>

    ${dotCard('Network in', hist.rx, d.rx, 'green', rate)}

    <article class="card insight">
      <span class="tag">Uptime</span>
      <b class="huge">${uptime(d.up)}</b>
      <h3>${esc(d.host)} is up and reachable.</h3>
      <p>${esc(d.os)} · kernel ${esc(d.kernel)}<br>${d.net.filter(n => n[0] !== 'lo' && n[1] !== 'DOWN').map(n => esc(`${n[0]} ${n[2] || ''}`)).join(' · ')}</p>
      <div class="segline"><i></i><i></i><i></i></div>
    </article>

    ${dotCard('Network out', hist.tx, d.tx, 'blue', rate)}

    <article class="card">
      <div class="card-top"><h2>Services</h2><button class="round" data-go="services" title="All services">${ICON.arrow}</button></div>
      <div class="svcs">${top.map(u => `<button class="svc" data-unit="${esc(u.unit)}" title="Show logs"><span class="ic ${svcClass(u)}">${esc(u.unit[0])}</span><span class="nm">${esc(u.unit.replace(/\.service$/, ''))}</span>${tag(u)}</button>`).join('')}</div>
    </article>

    <article class="card logs">
      <div class="card-top"><h2>Recent journal</h2><button class="pill" data-go="logs">All logs ›</button></div>
      <div class="timeline">${d.log.slice(-6).map(l => {
        const e = parseLog(l);
        return `<div class="ev ${isErr(e.msg) ? 'err' : ''}"><time>${esc(e.time)}</time><div><b>${esc(e.unit)}</b><span>${esc(e.msg)}</span></div></div>`;
      }).join('') || '<p>No journal access (add your user to the <code>adm</code> or <code>systemd-journal</code> group).</p>'}</div>
    </article>
  </section>`;
}

let events;
export function mount(el, { refresh }) {
  events = new AbortController();
  el.addEventListener('click', e => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'refresh') refresh();
    if (act === 'live') {
      state.live = !state.live;
      if (state.snap) el.innerHTML = render(state.snap);
    }
  }, { signal: events.signal });
}
export function dispose() { events?.abort(); }
