import { avg, agoLabel, plural } from './dom.js';

// CPU percentages sampled every 5s; gaps preserve unavailable readings.
export function stepChart(vals) {
  if (vals.length < 5) return collecting(vals.length);
  const valid = vals.filter(Number.isFinite);
  if (!valid.length) return '<p class="unavailable">CPU history unavailable</p>';
  const W = 300, H = 170, n = vals.length, top = Math.max(...valid);
  const max = Math.max(top, 10) * 1.2, x = i => (i / n) * W, y = v => H - (v / max) * H;
  const segments = [];
  vals.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    if (!Number.isFinite(vals[i - 1])) segments.push({ start: x(i), end: x(i + 1), d: `M${x(i).toFixed(1)} ${y(v).toFixed(1)}` });
    const segment = segments.at(-1);
    segment.d += ` V${y(v).toFixed(1)} H${x(i + 1).toFixed(1)}`;
    segment.end = x(i + 1);
  });
  const d = segments.map(s => s.d).join(' ');
  const area = segments.map(s => `${s.d} V${H} H${s.start.toFixed(1)}Z`).join(' ');
  const pk = vals.indexOf(top), px = ((x(pk) + x(pk + 1)) / 2 / W) * 100, py = (y(top) / H) * 100;
  const labels = [0, 1, 2, 3].map(k => Math.round(((n - 1) * (3 - k) * 5) / 3));
  return `<div class="step">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path d="${area}" fill="var(--accent)" fill-opacity=".08"/>
      <path d="${d}" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    </svg>
    <i class="pdot" style="left:${px}%;top:${py}%"></i>
    <span class="tip" style="left:${px}%;top:${py}%">${top.toFixed(0)}%</span>
  </div>
  <div class="axis">${labels.map(s => `<span>${s ? agoLabel(s) : 'now'}</span>`).join('')}</div>`;
}

// Each network sample is a two-column stack of up to four rows.
export function dots(vals, cls, fmt) {
  if (!vals.length) return '<div class="dots"></div>';
  const max = Math.max(...vals.filter(Number.isFinite)) || 1, pk = vals.indexOf(max);
  return `<div class="dots ${cls}">${vals.map((v, i) => !Number.isFinite(v) ? '<div class="empty"></div>' : `<div class="${i === pk ? 'pk' : ''}">${i === pk ? `<span class="tip">Peak: <b>${fmt(v)}</b></span>` : ''}${'<i></i>'.repeat(2 * Math.max(1, Math.ceil((v / max) * 4)))}</div>`).join('')}</div>`;
}

export function dotCard(title, vals, now, cls, fmt) {
  const valid = vals.filter(Number.isFinite);
  const diff = Number.isFinite(now) && valid.length ? now - avg(valid) : null;
  const [n, unit] = Number.isFinite(now) ? fmt(now).split(' ') : ['Unavailable', ''];
  return `<article class="card dotcard">
    <div class="card-top"><h2>${title}</h2><span class="muted">last ${plural(vals.length, 'sample')}</span></div>
    <div class="dotrow">
      <b class="huge">${n}<small>${unit || ''}</small></b>
      ${vals.length >= 5 ? dots(vals, cls, fmt) : ''}
      ${vals.length >= 5 ? `<div class="vs"><span class="muted">vs average</span><b>${diff === null ? 'Unavailable' : (diff >= 0 ? '+' : '−') + fmt(Math.abs(diff))}</b></div>` : ''}
    </div>${vals.length < 5 ? collecting(vals.length) : ''}
  </article>`;
}


export const collecting = n => `<p class="muted collecting">Collecting samples (${n} of 5)…</p>`;
