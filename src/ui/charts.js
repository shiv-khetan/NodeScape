import { avg, agoLabel } from './dom.js';

// Step-line area chart (the "Retention" card); values are 0-100 percentages sampled every 5s.
export function stepChart(vals) {
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
export function dots(vals, cls, fmt) {
  if (!vals.length) return '<div class="dots"></div>';
  const max = Math.max(...vals) || 1, pk = vals.indexOf(Math.max(...vals));
  return `<div class="dots ${cls}">${vals.map((v, i) => `<div class="${i === pk ? 'pk' : ''}">${i === pk ? `<span class="tip">Peak: <b>${fmt(v)}</b></span>` : ''}${'<i></i>'.repeat(2 * Math.max(1, Math.ceil((v / max) * 4)))}</div>`).join('')}</div>`;
}

export function dotCard(title, vals, now, cls, fmt) {
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


export function bars(samples) {
  const bars = [...Array(Math.max(0, 7 - samples.length)).fill(null), ...samples.slice(-7)];
  return `<div class="bars">${bars.map((v, i) => v == null
        ? '<div class="bar empty"><i></i></div>'
        : `<div class="bar ${i === 6 ? 'now' : ''}"><i style="height:${Math.max(3, v)}%">${i === 6 ? `<span class="tip"><b>${v.toFixed(1)}%</b> CPU · sampled every 5s</span>` : ''}</i></div>`).join('')}
      </div>`;
}

export function gauge(loadPct, load, cpus) {
  const C = 2 * Math.PI * 70;
  return `<div class="gauge">
        <svg viewBox="0 0 168 168">
          <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a9c6ff"/><stop offset="1" stop-color="#1f5eff"/></linearGradient></defs>
          <circle cx="84" cy="84" r="70" stroke="#e8ebf1" stroke-width="12"/>
          <circle cx="84" cy="84" r="54" stroke="#c9d3e3" stroke-width="4" stroke-dasharray="1 5"/>
          <circle cx="84" cy="84" r="70" stroke="url(#lg)" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(C * loadPct) / 100} ${C}"/>
        </svg>
        <div class="c"><b>${loadPct}%</b><span>${load.toFixed(2)} on ${cpus} cores</span></div>
      </div>`;
}
