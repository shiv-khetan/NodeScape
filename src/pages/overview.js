import { state, history } from '../state.js';
import { pct, avg, gib, rate, uptime, esc, stat, svcClass, tag, ICON } from '../ui/dom.js';
import { parseLog, isErr } from '../ui/parse.js';
import { bars, gauge, stepChart, dotCard } from '../ui/charts.js';

export function render(d) {
  const hist = history(), { host, live } = state;
  const [total, , free, , , avail] = d.mem;
  const hasMem = [total, free, avail].every(v => Number.isFinite(v) && v >= 0) && total > 0 && avail <= total && free <= total;
  const used = hasMem ? pct(total - avail, total) : null, fr = hasMem ? pct(free, total) : null;
  const ca = hasMem ? Math.max(0, 100 - used - fr) : null;
  const cpuSamples = hist.cpu.filter(Number.isFinite);
  const load = v => Number.isFinite(v) ? v.toFixed(2) : 'Unavailable';
  const running = d.units.filter(u => u.sub === 'running');
  const failed = d.units.filter(u => u.active === 'failed');
  const loadPct = Number.isFinite(d.load[0]) && d.cpus ? Math.min(100, pct(d.load[0], d.cpus)) : null;
  const top = [...failed, ...running].slice(0, 6);
  const hasSwap = d.swap.length >= 3 && d.swap.every(v => Number.isFinite(v) && v >= 0) && d.swap[1] <= d.swap[0];
  const meters = [...(hasSwap && d.swap[0] > 0 ? [['Swap', d.swap[1], d.swap[0]]] : []), ...[...d.disks].sort((x, y) => y.size - x.size).slice(0, 3).map(x => [x.target, x.used, x.size])].filter(m => m[2]);
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
        ${stat('Usage now', Number.isFinite(d.cpu) ? Math.round(d.cpu) + '%' : 'Unavailable', true)}${stat('Load 1m', load(d.load[0]))}${stat('Load 5m', load(d.load[1]))}${stat('Load 15m', load(d.load[2]))}${stat('Cores', d.cpus ?? 'Unavailable')}
      </div>
      ${bars(hist.cpu)}
    </article>

    <article class="card">
      <div class="card-top"><h2>Load</h2><button class="round" data-act="refresh" title="Refresh now">${ICON.refresh}</button></div>
      ${gauge(loadPct, d.load[0], d.cpus)}
    </article>

    <article class="card">
      <div class="card-top"><h2>Memory</h2><span class="muted">${hasMem ? gib(total) + ' total' : 'Unavailable'}</span></div>
      ${hasMem ? `<div class="bignum"><b>${gib(total - avail)}</b><span class="badge">${used}%</span></div>
      <span class="muted">used · ${ca}% cache · ${fr}% free</span>` : '<p class="unavailable">Memory unavailable</p>'}
      ${!hasSwap ? '<p class="unavailable">Swap unavailable</p>' : d.swap[0] === 0 ? '<p class="unavailable">no swap</p>' : ''}
      ${!d.disks.length ? '<p class="unavailable">Disk usage unavailable</p>' : ''}
      ${meters.map((m, i) => `<div class="meter"><div><span>${esc(m[0])}</span><b>${pct(m[1], m[2])}% of ${gib(m[2])}</b></div><div class="track"><i class="${stripes[i % 4]}" style="width:${pct(m[1], m[2])}%"></i></div></div>`).join('')}
    </article>

    <article class="card history">
      <div class="card-top"><h2>CPU history</h2><span class="muted">${cpuSamples.length ? 'avg ' + avg(cpuSamples).toFixed(0) + '%' : 'Unavailable'}</span></div>
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
      ${d.journalLimited ? "<p class=\"notice journal-access\">Only this user's journal is visible. Add the user to the <code>adm</code> or <code>systemd-journal</code> group to see system logs.</p>" : ''}
      <div class="timeline">${d.log.slice(-6).map(l => {
        const e = parseLog(l);
        return `<div class="ev ${isErr(e.msg) ? 'err' : ''}"><time>${esc(e.time)}</time><div><b>${esc(e.unit)}</b><span>${esc(e.msg)}</span></div></div>`;
      }).join('') || '<p class="unavailable">No journal entries available.</p>'}</div>
    </article>

    ${temperatureCard(d.temps)}
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

function temperatureCard(temps = []) {
  const hottest = temps.length ? Math.max(...temps.map(t => t.celsius)) : null;
  return `<article class="card temperatures">
    <div class="card-top"><h2>Temperatures</h2><span class="muted">hottest sensor</span></div>
    ${hottest === null ? '<p class="unavailable">Temperature sensors unavailable (install lm-sensors)</p>' : `
      <div class="temp-reading"><b class="temp-value">${+hottest.toFixed(1)} °C</b></div>
      ${temps.map(t => {
        const severity = t.crit != null && t.celsius >= t.crit ? 'hot' : t.high != null && t.celsius >= t.high - 5 ? 'warm' : 'blue';
        const ceiling = t.crit > 0 ? t.crit : t.high > 0 ? t.high : 100;
        const width = Math.max(0, Math.min(100, 100 * t.celsius / ceiling));
        const limits = [t.high != null ? 'high ' + t.high + ' °C' : '', t.crit != null ? 'critical ' + t.crit + ' °C' : ''].filter(Boolean).join(' · ');
        return `<div class="meter" title="${esc(limits)}"><div><span>${esc(t.label)}</span><b>${+t.celsius.toFixed(1)} °C</b></div><div class="track" role="meter" aria-label="${esc(t.label)}" aria-valuemin="${Math.min(0, t.celsius)}" aria-valuemax="${Math.max(ceiling, t.celsius)}" aria-valuenow="${t.celsius}" aria-valuetext="${esc(t.celsius + ' °C' + (limits ? ' · ' + limits : ''))}"><i class="${severity}" style="width:${width}%"></i></div></div>`;
      }).join('')}`}
  </article>`;
}
