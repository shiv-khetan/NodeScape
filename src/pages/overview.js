import { state, history } from '../state.js';
import { pct, avg, gib, rate, uptime, esc, stat, tag, ICON, head, agoLabel, plural } from '../ui/dom.js';
import { parseLog, isErr, temperatureLabels } from '../ui/parse.js';
import { stepChart, dotCard } from '../ui/charts.js';

import { performServiceAction } from './services.js';

export const meterClass = value => value >= 95 ? 'hot' : value >= 85 ? 'warm' : 'neutral';
export function freshness() {
  const ago = agoLabel(Math.max(0, Math.floor((Date.now() - state.snapshotAt) / 1000)));
  return `<span data-freshness class="${state.snapshotError ? 'error' : ''}">${state.snapshotError ? 'Last updated ' + ago + ' · refresh failed' : 'updated ' + ago}</span>`;
}

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
  const top = running.slice(0, 6);
  const hasSwap = d.swap.length >= 3 && d.swap.every(v => Number.isFinite(v) && v >= 0) && d.swap[1] <= d.swap[0];
  const meters = [...(hasSwap && d.swap[0] > 0 ? [['Swap', d.swap[1], d.swap[0]]] : []), ...[...d.disks].sort((x, y) => y.size - x.size).slice(0, 3).map(x => [x.target, x.used, x.size])].filter(m => m[2]);
  const errors = d.journalLimited ? [] : d.log.filter(isErr);
  const problems = failed.length || errors.length;
  const problemRow = problems ? `<article class="card full problems"><div class="card-top"><h2>${failed.length ? plural(failed.length, 'service') + ' failed' : plural(errors.length, 'recent journal error')}</h2><button class="ghost" data-go="services">View all services</button></div>${failed.map(u => `<div class="problem-row" data-problem-unit="${esc(u.unit)}"><div class="problem-unit"><b>${esc(u.unit)}</b><span class="muted">${esc(u.desc)}</span></div>${tag(u)}<div class="acts"><button data-svc="restart" data-u="${esc(u.unit)}">Restart</button><button data-unit="${esc(u.unit)}">Logs</button></div></div>`).join('')}${errors.length && failed.length ? `<div class="journal-problem"><span>${plural(errors.length, 'recent journal error')}</span><button class="ghost" data-go="logs">View logs</button></div>` : !failed.length ? '<button class="ghost" data-go="logs">View logs</button>' : ''}</article>` : `<div class="full health-line"><span class="all-clear tag status ok">All services running · no recent errors</span><button class="ghost" data-go="services">View all services</button></div>`;

  return `
  ${head('Overview', esc(d.host) + ' · ' + esc(d.ip || host) + ' · ' + freshness(), '', '', '<button data-act="live" aria-pressed="' + live + '">' + (live ? ICON.pause + ' Pause live updates' : ICON.play + ' Resume live updates') + '</button>')}
  <section class="grid overview-grid">
    ${problemRow}
    <article class="card cpu">
      <div class="card-top"><h2>CPU</h2><span class="muted">${cpuSamples.length ? 'avg ' + avg(cpuSamples).toFixed(0) + '%' : ''}</span><button class="round" data-go="processes" title="Processes">${ICON.arrow}</button></div>
      <div class="stats">
        ${stat('Usage now', Number.isFinite(d.cpu) ? Math.round(d.cpu) + '%' : 'Unavailable', true)}${stat('Load 1m', load(d.load[0]))}${stat('Load 5m', load(d.load[1]))}${stat('Load 15m', load(d.load[2]))}${stat('Cores', d.cpus ?? 'Unavailable')}
      </div>
      ${stepChart(hist.cpu.slice(-20))}
    </article>

    <article class="card">
      <div class="card-top"><h2>Memory</h2><span class="muted">${hasMem ? gib(total) + ' total' : 'Unavailable'}</span></div>
      ${hasMem ? `<div class="bignum"><b>${gib(total - avail)}</b><span class="badge">${used}%</span></div>
      <span class="muted">used · ${ca}% cache · ${fr}% free</span>` : '<p class="unavailable">Memory unavailable</p>'}
      ${!hasSwap ? '<p class="unavailable">Swap unavailable</p>' : d.swap[0] === 0 ? '<p class="unavailable">no swap</p>' : ''}
      ${!d.disks.length ? '<p class="unavailable">Disk usage unavailable</p>' : ''}
      ${meters.map((m, i) => `<div class="meter"><div><span>${esc(m[0])}</span><b>${pct(m[1], m[2])}% of ${gib(m[2])}</b></div><div class="track"><i class="${meterClass(pct(m[1], m[2]))}" style="width:${pct(m[1], m[2])}%"></i></div></div>`).join('')}
    </article>

    ${temperatureCard(d.temps)}

    <article class="card logs">
      <div class="card-top"><h2>Recent journal</h2><button class="pill" data-go="logs">All logs ›</button></div>
      ${d.journalLimited ? "<p class=\"notice journal-access\">Only this user's journal is visible. Add the user to the <code>adm</code> or <code>systemd-journal</code> group to see system logs.</p>" : ''}
      <div class="timeline">${d.log.slice(-6).map(l => {
        const e = parseLog(l);
        return `<div class="logrow ${isErr(e.msg) ? 'err' : ''}"><time>${esc(e.time)}</time><span class="tag">${esc(e.unit)}</span><span class="msg">${isErr(e.msg) ? '<b class="sev">Error</b>' : ''}${esc(e.msg)}</span></div>`;
      }).join('') || '<p class="unavailable">No journal entries available.</p>'}</div>
    </article>

    <article class="card services-card">
      <div class="card-top"><h2>Services</h2><span class="muted">${running.length} running</span><button class="round" data-go="services" title="All services">${ICON.arrow}</button></div>
      <div class="svcs">${top.map(u => `<button class="svc" data-unit="${esc(u.unit)}" title="Show logs"><span class="nm">${esc(u.unit.replace(/\.service$/, ''))}</span>${tag(u)}</button>`).join('') || '<p class="unavailable">No running services.</p>'}</div>${running.length > top.length ? `<button class="ghost more-running" data-go="services">+${running.length - top.length} more running</button>` : ''}
    </article>

    ${dotCard('Network in', hist.rx, d.rx, 'green', rate)}
    ${dotCard('Network out', hist.tx, d.tx, 'blue', rate)}

    <p class="full system-strip muted"><b>Up ${uptime(d.up)}</b> · ${esc(d.os)} · kernel ${esc(d.kernel)} · ${d.net.filter(n => n[0] !== 'lo' && n[1] !== 'DOWN').map(n => esc(n[0] + ' ' + (n[2] || ''))).join(' · ')}</p>
  </section>`;
}

let events, freshnessTimer;
export function mount(el, { refresh }) {
  events = new AbortController();
  freshnessTimer = setInterval(() => { const node = el.querySelector('[data-freshness]'); if (node) node.outerHTML = freshness(); }, 1000);
  el.addEventListener('click', async e => {
    const button = e.target.closest('button'), act = button?.dataset.act;
    if (button?.dataset.svc) await performServiceAction(el, button.dataset.svc, button.dataset.u, 'system', refresh);
    if (act === 'live') {
      state.live = !state.live;
      if (state.snap) el.innerHTML = render(state.snap);
    }
  }, { signal: events.signal });
}
export function dispose() { events?.abort(); clearInterval(freshnessTimer); }

function temperatureCard(temps = []) {
  const labels = temperatureLabels(temps);
  const hottest = temps.length ? Math.max(...temps.map(t => t.celsius)) : null;
  return `<article class="card temperatures">
    <div class="card-top"><h2>Temperatures</h2><span class="muted">hottest sensor</span></div>
    ${hottest === null ? '<p class="unavailable">Temperature sensors unavailable (install lm-sensors)</p>' : `
      <div class="temp-reading"><b class="temp-value">${+hottest.toFixed(1)} °C</b></div>
      ${temps.map((t, i) => {
        const ceiling = t.crit > 0 ? t.crit : t.high > 0 ? t.high : 100;
        const width = Math.max(0, Math.min(100, 100 * t.celsius / ceiling));
        const limits = [t.high != null ? 'high ' + t.high + ' °C' : '', t.crit != null ? 'critical ' + t.crit + ' °C' : ''].filter(Boolean).join(' · ');
        return `<div class="meter" title="${esc(limits)}"><div><span class="meter-label" title="${esc(t.label)}">${esc(labels[i])}</span><b>${+t.celsius.toFixed(1)} °C</b></div><div class="track" role="meter" aria-label="${esc(t.label)}" aria-valuemin="${Math.min(0, t.celsius)}" aria-valuemax="${Math.max(ceiling, t.celsius)}" aria-valuenow="${t.celsius}" aria-valuetext="${esc(t.celsius + ' °C' + (limits ? ' · ' + limits : ''))}"><i class="${meterClass(width)}" style="width:${width}%"></i></div></div>`;
      }).join('')}`}
  </article>`;
}
