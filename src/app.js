const store = (k, v) => { try { return v === undefined ? localStorage.getItem(k) : localStorage.setItem(k, v); } catch { return null; } };
const invoke = (cmd, args = {}) =>
  args.host === 'demo' || !window.__TAURI__ ? window.demoInvoke(cmd, args) : window.__TAURI__.core.invoke(cmd, { ...args, config: store('sshConfig') || null });
const $ = s => document.querySelector(s);
const main = $('#main'), hostInput = $('#host');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const avg = a => a.reduce((p, c) => p + c, 0) / (a.length || 1);
const gib = b => (b / 2 ** 30 >= 1000 ? (b / 2 ** 40).toFixed(1) + ' TiB' : (b / 2 ** 30).toFixed(1) + ' GiB');
const rate = b => (b >= 2 ** 20 ? (b / 2 ** 20).toFixed(1) + ' MB/s' : Math.round(b / 2 ** 10) + ' KB/s');
const ICON = {
  arrow: '<svg viewBox="0 0 24 24"><path d="M7 17 17 7M8 7h9v9"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M9 5v14M15 5v14"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
};
const emptyHist = () => ({ cpu: [], rx: [], tx: [] });

let host = localStorage.getItem('host') || 'demo';
let view = 'overview', live = true, busy = false, seq = 0, snap = null;
let hist = host === 'demo' ? window.demoHistory() : emptyHist();
let svcFilter = '', svcState = 'all', logUnit = '', logLines = 300;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 3500);
}

// --- parsing -------------------------------------------------------------

function sections(txt) {
  const out = {};
  let key;
  for (const line of txt.split('\n')) {
    // Section header; cron's "@reboot cmd" has a space so isn't one.
    if (/^@\w+$/.test(line.trim())) out[(key = line.trim().slice(1))] = [];
    else if (key && line.trim()) out[key].push(line);
  }
  return out;
}

const words = l => l.trim().split(/\s+/);

function parseUnits(lines = []) {
  return lines
    .map(l => { const [unit, load, active, sub, ...d] = words(l); return { unit, load, active, sub, desc: d.join(' ') }; })
    .filter(u => u.load === 'loaded');
}

// Sum rx/tx bytes from /proc/net/dev lines over the default-route interfaces only. Counting every
// interface double-counts tunnels: Tailscale traffic shows on tailscale0 and again on the Wi-Fi/LAN link.
const VIRTUAL = /^(lo|tailscale|wg|tun|tap|docker|veth|br-|virbr)/;
const netSum = (lines = [], devs = []) => lines.reduce((acc, l) => {
  const [name, rest] = l.split(':');
  const n = name.trim();
  if (!rest || (devs.length ? !devs.includes(n) : VIRTUAL.test(n))) return acc;
  const f = words(rest).map(Number);
  return [acc[0] + f[0], acc[1] + f[8]];
}, [0, 0]);

function parseSnapshot(txt) {
  const s = sections(txt);
  const [a, b] = (s.cpu || []).map(l => words(l).slice(1, 9).map(Number));
  const tot = x => x.reduce((p, c) => p + c, 0), idle = x => x[3] + x[4];
  const cpu = a && b ? Math.max(0, Math.min(100, 100 * (1 - (idle(b) - idle(a)) / (tot(b) - tot(a) || 1)))) : 0;
  const row = name => words((s.mem || []).find(l => l.startsWith(name)) || `${name} 0 0 0 0 0 0`).slice(1).map(Number);
  const devs = (s.gw || []).map(l => l.match(/\bdev (\S+)/)?.[1]).filter(Boolean);
  const [r1, t1] = netSum(s.rx1, devs), [r2, t2] = netSum(s.rx2, devs);
  return {
    host: s.host?.[0]?.trim() || host,
    os: s.os?.[0], kernel: s.kernel?.[0],
    // The address this SSH session actually reached (e.g. the Tailscale IP), not just the first one.
    ip: words(s.conn?.[0] || '')[2] || words(s.ip?.[0] || '')[0] || '',
    up: parseFloat(s.uptime?.[0]) || 0,
    load: words(s.load?.[0] || '0 0 0').slice(0, 3).map(Number),
    cpus: +s.cpus?.[0] || 1,
    cpu, mem: row('Mem:'), swap: row('Swap:'),
    rx: Math.max(0, (r2 - r1) * 2), tx: Math.max(0, (t2 - t1) * 2), // sampled 0.5s apart
    disks: (s.disk || []).map(l => { const [target, size, used] = words(l); return { target, size: +size, used: +used }; }).filter(d => d.size > 0),
    net: (s.net || []).map(words),
    units: parseUnits(s.svc),
    log: (s.log || []).filter(l => !l.startsWith('--')),
  };
}

const parseLog = l => {
  const m = l.match(/^(\S+)\s+\S+\s+([^:]+):\s?(.*)$/);
  return m ? { time: m[1].slice(11, 19), unit: m[2], msg: m[3] } : { time: '', unit: '', msg: l };
};
const isErr = s => /error|fail|fatal|denied|panic|critical/i.test(s);

function uptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : `${h}h ${m}m`;
}

// --- components ----------------------------------------------------------

const svcClass = u => (u.active === 'failed' ? 'bad' : u.sub === 'running' ? 'ok' : '');
const tag = u => `<span class="tag ${svcClass(u)}">${esc(u.sub)}</span>`;
const stat = (label, value, on) => `<div class="${on ? 'on' : ''}"><small>${label}</small><b>${value}</b></div>`;
const agoLabel = s => (s >= 60 ? Math.round(s / 60) + 'm ago' : s + 's ago');

// Step-line area chart (the "Retention" card); values are 0-100 percentages sampled every 5s.
function stepChart(vals) {
  if (vals.length < 2) return '<p class="muted">Collecting samples…</p>';
  const W = 300, H = 170, n = vals.length, top = Math.max(...vals);
  const max = Math.max(top, 10) * 1.2, x = i => (i / n) * W, y = v => H - (v / max) * H;
  const d = `M0 ${y(vals[0]).toFixed(1)}` + vals.map((v, i) => ` V${y(v).toFixed(1)} H${x(i + 1).toFixed(1)}`).join('');
  const pk = vals.indexOf(top), px = ((x(pk) + x(pk + 1)) / 2 / W) * 100, py = (y(top) / H) * 100;
  const labels = [0, 1, 2, 3].map(k => Math.round(((n - 1) * (3 - k) * 5) / 3));
  return `<div class="step">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs>
        <pattern id="vl" width="5" height="10" patternUnits="userSpaceOnUse"><path d="M2 0V10" stroke="#f472b6" stroke-opacity=".3" stroke-width="1.5"/></pattern>
        <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset=".2" stop-color="#f8f9fb" stop-opacity="0"/><stop offset="1" stop-color="#f8f9fb"/></linearGradient>
      </defs>
      <path d="${d} V${H} H0Z" fill="url(#vl)"/>
      <rect width="${W}" height="${H}" fill="url(#fade)"/>
      <path d="${d}" stroke="#ec4899" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    </svg>
    <i class="pdot" style="left:${px}%;top:${py}%"></i>
    <span class="tip" style="left:${px}%;top:${py}%">${top.toFixed(0)}%</span>
  </div>
  <div class="axis">${labels.map(s => `<span>${s ? agoLabel(s) : 'now'}</span>`).join('')}</div>`;
}

// Dot-matrix columns (the "Transactions" card): each sample is a 2-wide stack of 1–4 rows.
function dots(vals, cls, fmt) {
  if (!vals.length) return '<div class="dots"></div>';
  const max = Math.max(...vals) || 1, pk = vals.indexOf(Math.max(...vals));
  return `<div class="dots ${cls}">${vals.map((v, i) => `<div class="${i === pk ? 'pk' : ''}">${i === pk ? `<span class="tip">Peak: <b>${fmt(v)}</b></span>` : ''}${'<i></i>'.repeat(2 * Math.max(1, Math.ceil((v / max) * 4)))}</div>`).join('')}</div>`;
}

function dotCard(title, vals, now, cls, fmt) {
  const diff = now - avg(vals), [n, unit] = fmt(now).split(' ');
  return `<article class="card dotcard">
    <div class="card-top"><h2>${title}</h2><span class="muted">last ${vals.length} samples</span></div>
    <div class="dotrow">
      <b class="huge">${n}<small>${unit || ''}</small></b>
      ${dots(vals, cls, fmt)}
      <div class="vs"><span class="muted">vs average</span><b>${diff >= 0 ? '+' : '−'}${fmt(Math.abs(diff))}</b></div>
    </div>
  </article>`;
}

// --- views ---------------------------------------------------------------

function overview(d) {
  const [total, , free, , , avail] = d.mem;
  const used = pct(total - avail, total), fr = pct(free, total), ca = Math.max(0, 100 - used - fr);
  const running = d.units.filter(u => u.sub === 'running');
  const failed = d.units.filter(u => u.active === 'failed');
  const loadPct = Math.min(100, pct(d.load[0], d.cpus));
  const C = 2 * Math.PI * 70;
  const bars = [...Array(Math.max(0, 7 - hist.cpu.length)).fill(null), ...hist.cpu.slice(-7)];
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
      <div class="bars">${bars.map((v, i) => v == null
        ? '<div class="bar empty"><i></i></div>'
        : `<div class="bar ${i === 6 ? 'now' : ''}"><i style="height:${Math.max(3, v)}%">${i === 6 ? `<span class="tip"><b>${v.toFixed(1)}%</b> CPU · sampled every 5s</span>` : ''}</i></div>`).join('')}
      </div>
    </article>

    <article class="card">
      <div class="card-top"><h2>Load</h2><button class="round" data-act="refresh" title="Refresh now">${ICON.refresh}</button></div>
      <div class="gauge">
        <svg viewBox="0 0 168 168">
          <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a9c6ff"/><stop offset="1" stop-color="#1f5eff"/></linearGradient></defs>
          <circle cx="84" cy="84" r="70" stroke="#e8ebf1" stroke-width="12"/>
          <circle cx="84" cy="84" r="54" stroke="#c9d3e3" stroke-width="4" stroke-dasharray="1 5"/>
          <circle cx="84" cy="84" r="70" stroke="url(#lg)" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(C * loadPct) / 100} ${C}"/>
        </svg>
        <div class="c"><b>${loadPct}%</b><span>${d.load[0].toFixed(2)} on ${d.cpus} cores</span></div>
      </div>
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

function head(title, sub, controls = '') {
  return `<section class="hero"><h1>${title}</h1>${sub ? `<span class="hostchip">${sub}</span>` : ''}<div class="toolbar">${controls}</div></section>`;
}

const segTabs = (attr, cur, opts) => `<div class="segtabs">${opts.map(([v, label]) => `<button data-${attr}="${v}" class="${String(v) === String(cur) ? 'on' : ''}">${label}</button>`).join('')}</div>`;

function services(d) {
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

function processes(txt) {
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

function logsView(txt) {
  // Keep only real entries: drops journalctl's "Hint:" notice, "-- Boot … --" separators and "-- No entries --".
  const lines = txt.split('\n').filter(l => /^\d{4}-\d\d-\d\dT/.test(l));
  const limited = /not seeing messages from other users/.test(txt);
  const errs = lines.filter(isErr).length;
  return head('Logs', logUnit ? esc(logUnit) : 'all units', `
    <input class="field" id="logunit" placeholder="Unit, e.g. nginx (blank = all)" value="${esc(logUnit)}">
    ${segTabs('lines', logLines, [[100, '100'], [300, '300'], [1000, '1000']])}
    <button class="round dark" data-act="refresh" title="Load">${ICON.refresh}</button>`) + `
  <section class="grid">
    ${limited ? `<article class="card full notice">Only <b>${esc(host)}</b>'s own user journal is visible. Add the user to the <code>adm</code> or <code>systemd-journal</code> group to see system logs.</article>` : ''}
    <article class="card full"><div class="stats">${stat('Lines', lines.length, true)}${stat('Errors', errs)}${stat('From', lines.length ? esc(parseLog(lines[0]).time) : '—')}${stat('To', lines.length ? esc(parseLog(lines.at(-1)).time) : '—')}</div></article>
    <article class="card full"><div class="loglist">${lines.map(l => {
      const e = parseLog(l);
      return `<div class="logrow ${isErr(l) ? 'err' : ''}"><time>${esc(e.time)}</time><span class="tag">${esc(e.unit.replace(/\[\d+\]$/, '')) || 'log'}</span><span class="msg">${esc(e.msg)}</span></div>`;
    }).join('') || '<p class="muted">No log lines.</p>'}</div></article>
  </section>`;
}

function timersView(txt) {
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

// --- data flow -----------------------------------------------------------

function emptyState() {
  main.innerHTML = `<div class="empty"><h1>Pick a server</h1>
    <p>Type an alias from your ssh config (pick the file under Settings) or <code>user@host</code> above, or <code>demo</code> for sample data.</p>
    <p>NodeScape uses your system <code>ssh</code> with key auth (ssh-agent). Nothing is installed on the server.</p></div>`;
}

// Only the latest call renders; a timer tick skips while a call is in flight.
async function refresh(fromTimer) {
  if (!host) return emptyState();
  if (fromTimer === true && busy) return;
  const id = ++seq;
  busy = true;
  $('#refresh').classList.add('spin');
  try {
    let html;
    if (view === 'overview' || view === 'services') {
      snap = parseSnapshot(await invoke('query', { host, what: 'snapshot' }));
      hist = { cpu: [...hist.cpu, snap.cpu].slice(-48), rx: [...hist.rx, snap.rx].slice(-14), tx: [...hist.tx, snap.tx].slice(-14) };
      html = view === 'overview' ? overview(snap) : services(snap);
    } else if (view === 'processes') html = processes(await invoke('query', { host, what: 'processes' }));
    else if (view === 'timers') html = timersView(await invoke('query', { host, what: 'timers' }));
    else html = logsView(await invoke('logs', { host, unit: logUnit || null, lines: logLines }));
    if (id !== seq) return;
    const focused = document.activeElement?.id;
    main.innerHTML = html;
    if (focused) main.querySelector('#' + focused)?.focus();
    if (view === 'services') applyFilter();
    const list = main.querySelector('.loglist');
    if (view === 'logs' && list) list.scrollTop = list.scrollHeight;
  } catch (e) {
    const hostKey = e?.kind === 'host_key_unknown' || e?.kind === 'host_key_changed';
    if (id === seq) main.innerHTML = `<div class="empty"><h1>Can't reach ${esc(host)}</h1><p class="error">${esc(e?.message ?? String(e))}</p>
      <p>${hostKey
        ? `The server's host key isn't trusted yet, or it changed. NodeScape never accepts host keys on its own: connect once with <code>ssh ${esc(host)}</code> in a terminal and check the fingerprint.`
        : `Check that <code>ssh ${esc(host)}</code> works in a terminal without a password prompt.`}</p></div>`;
  } finally {
    if (id === seq) {
      busy = false;
      $('#refresh').classList.remove('spin');
    }
  }
}

function applyFilter() {
  const q = svcFilter.toLowerCase();
  main.querySelectorAll('tbody tr').forEach(r => (r.hidden = (!!q && !r.dataset.q.includes(q)) || (svcState !== 'all' && r.dataset.st !== svcState)));
}

function go(v) {
  view = v;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  main.innerHTML = '';
  refresh();
}

// --- events --------------------------------------------------------------

$('#nav').addEventListener('click', e => e.target.dataset.view && go(e.target.dataset.view));
$('#refresh').addEventListener('click', refresh);
hostInput.addEventListener('change', () => {
  host = hostInput.value.trim();
  localStorage.setItem('host', host);
  hist = host === 'demo' ? window.demoHistory() : emptyHist();
  refresh();
});

main.addEventListener('input', e => {
  if (e.target.id === 'filter') { svcFilter = e.target.value; applyFilter(); }
});
main.addEventListener('keydown', e => {
  if (e.target.id === 'logunit' && e.key === 'Enter') { logUnit = e.target.value.trim(); refresh(); }
});

main.addEventListener('click', async e => {
  const el = e.target.closest('button');
  if (!el) return;
  const ds = el.dataset;
  if (ds.go) go(ds.go);
  if (ds.unit) { logUnit = ds.unit; go('logs'); }
  if (ds.state) { svcState = ds.state; main.querySelectorAll('[data-state]').forEach(b => b.classList.toggle('on', b === el)); applyFilter(); }
  if (ds.lines) { logLines = +ds.lines; refresh(); }
  if (ds.act === 'refresh') {
    const u = main.querySelector('#logunit');
    if (u) logUnit = u.value.trim();
    refresh();
  }
  if (ds.act === 'live') { live = !live; snap && (main.innerHTML = overview(snap)); }
  if (ds.svc) {
    const { svc: action, u: unit } = ds;
    if (action !== 'start' && !confirm(`${action} ${unit} on ${host}?`)) return;
    try {
      await invoke('service_action', { host, unit, action });
      toast(`${action} ${unit}: ok`);
      refresh();
    } catch (err) {
      toast(err?.kind === 'sudo_required' ? 'sudo needs a password — allow passwordless systemctl for this user' : (err?.message ?? String(err)));
    }
  }
});

setInterval(() => live && view === 'overview' && refresh(true), 5000);

const loadHosts = () => invoke('hosts').then(hs => ($('#hosts').innerHTML = ['demo', ...hs].map(h => `<option value="${esc(h)}">`).join(''))).catch(() => {});

const dlg = $('#settings');
$('#settingsBtn').addEventListener('click', () => { $('#sshConfig').value = store('sshConfig') || ''; dlg.showModal(); });
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  store('sshConfig', $('#sshConfig').value.trim().replace(/^"(.*)"$/, '$1'));
  loadHosts();
  refresh();
});

hostInput.value = host;
loadHosts();
refresh();
