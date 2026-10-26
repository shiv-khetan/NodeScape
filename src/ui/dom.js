export const $ = s => document.querySelector(s);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
export const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
export const avg = a => a.reduce((p, c) => p + c, 0) / (a.length || 1);
export const gib = b => (b / 2 ** 30 >= 1000 ? (b / 2 ** 40).toFixed(1) + ' TiB' : (b / 2 ** 30).toFixed(1) + ' GiB');
export const rate = b => (b >= 2 ** 20 ? (b / 2 ** 20).toFixed(1) + ' MB/s' : Math.round(b / 2 ** 10) + ' KB/s');
export const ICON = {
  arrow: '<svg viewBox="0 0 24 24"><path d="M7 17 17 7M8 7h9v9"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M9 5v14M15 5v14"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
};
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 3500);
}

export function uptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : `${h}h ${m}m`;
}

export const svcClass = u => (u.active === 'failed' ? 'bad' : u.sub === 'running' ? 'ok' : '');
export const tag = u => `<span class="tag ${svcClass(u)}">${esc(u.sub)}</span>`;
export const stat = (label, value, on) => `<div class="${on ? 'on' : ''}"><small>${label}</small><b>${value}</b></div>`;
export const agoLabel = s => (s >= 60 ? Math.round(s / 60) + 'm ago' : s + 's ago');

export function head(title, sub, controls = '') {
  return `<section class="hero"><h1>${title}</h1>${sub ? `<span class="hostchip">${sub}</span>` : ''}<div class="toolbar">${controls}</div></section>`;
}

export const segTabs = (attr, cur, opts) => `<div class="segtabs">${opts.map(([v, label]) => `<button data-${attr}="${v}" class="${String(v) === String(cur) ? 'on' : ''}">${label}</button>`).join('')}</div>`;

