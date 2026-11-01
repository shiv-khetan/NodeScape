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
export const tag = u => `<span class="tag status ${svcClass(u)}">${esc(u.sub)}</span>`;
export const stat = (label, value, on) => `<div class="${on ? 'on' : ''}"><small>${label}</small><b>${value}</b></div>`;
export const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
export function elapsed(value) {
  const match = String(value).match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return value;
  const [, days, hours, minutes, seconds] = match;
  return +days ? +days + 'd ' + (+hours || 0) + 'h' : +hours ? +hours + 'h ' + +minutes + 'm' : +minutes ? +minutes + 'm' : +seconds + 's';
}

// Shortcut labels and where remembered passwords live differ on a Mac.
export const isMac = /Mac/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl+';
export const secretStore = isMac ? 'your macOS keychain' : 'Windows Credential Manager';

export const agoLabel = s => (s >= 60 ? Math.round(s / 60) + 'm ago' : s + 's ago');

// Page toolbars order search, filters, then actions; section tools stay in their panel header on pages with several tables.
export function head(title, sub, controls = '', filters = '', actions = '') {
  return `<section class="hero page-head"><div><h1>${title}</h1>${sub ? `<p class="page-meta">${sub}</p>` : ''}</div><div class="header-actions">${actions}</div></section><div class="page-toolbar">${controls}${filters}</div>`;
}

export const search = (id, label, value = '') => `<label class="search">${'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>'}<input class="field" type="search" id="${id}" aria-label="${label}" placeholder="${label}…" value="${esc(value)}"></label>`;
export function dateTime(value) {
  if (value == null || value === '' || value === 'n/a') return '—';
  const date = new Date(value);
  return Number.isNaN(+date) ? String(value) : date.toISOString().slice(0,16).replace('T',' ') + ' UTC';
}

// A filter group with one option is noise, so it renders nothing.
const filterNames = {state:'Filter services by state',scope:'Service scope',logstate:'Filter journal by severity',lines:'Journal line count',schedule:'Filter schedules by type',protocol:'Filter ports by protocol','file-kind':'Filter files by type','account-filter':'Filter users by access'};
export const segTabs = (attr, cur, opts, label = filterNames[attr] || 'Filter ' + attr) => opts.length < 2 ? '' : `<div class="segtabs" role="group" aria-label="${esc(label)}">${opts.map(([v, label]) => `<button data-${attr}="${v}" class="${String(v) === String(cur) ? 'on' : ''}" aria-pressed="${String(v) === String(cur)}">${label}</button>`).join('')}</div>`;

