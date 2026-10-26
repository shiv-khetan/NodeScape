import { esc, head, stat, segTabs } from '../ui/dom.js';

const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const show = value => esc(text(value) || '—');
function json(value) { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } }
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const array = value => { const parsed = json(value); return Array.isArray(parsed) && parsed.every(object) ? parsed : null; };
const unavailable = '<p class="muted">Unavailable · tool missing, stopped, or unreadable</p>';
const table = (headers, rows) => '<div class="network-table"><table><thead><tr>' + headers.map(h => '<th scope="col">' + h + '</th>').join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
let filter = '', protocol = 'all', events;

export function render(input) {
  const d = json(input) || {};
  const interfaces = array(d.interfaces), routes4 = array(d.routes4), routes6 = array(d.routes6), ports = array(d.ports);
  const firewall = object(d.firewall) ? d.firewall : {};
  const states = ['ufw', 'nftables', 'firewalld'].map(k => text(firewall[k]));
  const firewallState = states.includes('active') ? 'Active' : states.every(s => s === 'inactive') ? 'Inactive' : 'Unavailable';
  const ts = json(d.tailscale);
  const tailscale = object(ts) && (!ts.BackendState || ts.BackendState === 'Running') && object(ts.Self) && typeof ts.Self.HostName === 'string' && array(ts.peers) ? ts : null;
  const ips = node => Array.isArray(node.TailscaleIPs) ? node.TailscaleIPs.filter(ip => typeof ip === 'string').map(esc).join(', ') : '—';
  const nodeRow = (node, own = false) => '<tr><td>' + show(node.HostName) + (own ? ' <span class="tag">Self</span>' : '') + '</td><td>' + ips(node) + '</td><td>' + (node.Online === true ? 'Online' : node.Online === false ? 'Offline' : 'Unavailable') + '</td><td>' + show(node.OS) + '</td><td>' + (own ? '—' : show(node.LastSeen)) + '</td></tr>';
  const routeRows = (routes, family) => (routes || []).map(r => {
    const isDefault = ['default', '0.0.0.0/0', '::/0'].includes(r.dst);
    return '<tr class="' + (isDefault ? 'network-default' : '') + '"><td>' + (isDefault ? '<span class="tag ok">Default</span>' : show(r.dst)) + '</td><td>' + family + '</td><td>' + show(r.gateway) + '</td><td>' + show(r.dev) + '</td><td>' + show(r.metric) + '</td></tr>';
  }).join('');
  return head('Network', 'Read-only inspection') + '<section class="grid network">' +
    '<article class="card full"><div class="stats">' +
    stat('Interfaces up', interfaces ? interfaces.filter(i => i.operstate === 'UP').length : 'Unavailable', true) +
    stat('Listening ports', ports ? ports.length : 'Unavailable') + stat('Firewall state', firewallState) +
    stat('Tailscale peers online', tailscale ? tailscale.peers.filter(p => p.Online === true).length : 'Unavailable') + '</div></article>' +
    '<section id="network-interfaces" class="full"><h2>Interfaces</h2><div class="network-interfaces">' +
    (interfaces ? interfaces.map(i => '<article class="card"><div class="card-top"><h3>' + show(i.ifname) + '</h3><span class="tag ' + (i.operstate === 'UP' ? 'ok' : '') + '">' + show(i.operstate) + '</span></div><div class="mono">' +
      (array(i.addr_info)?.map(a => '<p>' + show(a.local) + (Number.isInteger(a.prefixlen) ? '/' + esc(a.prefixlen) : '') + '</p>').join('') || '<p class="muted">No addresses</p>') + '</div></article>').join('') || '<p class="muted">No interfaces</p>' : unavailable) + '</div></section>' +
    '<article id="network-routes" class="card full"><div class="card-top"><h2>Routes</h2></div>' +
    (routes4 === null ? '<p class="muted">IPv4: Unavailable</p>' : '') + (routes6 === null ? '<p class="muted">IPv6: Unavailable</p>' : '') +
    (routes4 || routes6 ? table(['Destination', 'Family', 'Gateway', 'Interface', 'Metric'], routeRows(routes4, 'IPv4') + routeRows(routes6, 'IPv6')) + (!routes4?.length && !routes6?.length ? '<p class="muted">No routes</p>' : '') : '') + '</article>' +
    '<article id="network-ports" class="card full"><div class="card-top"><h2>Listening ports</h2>' + segTabs('protocol', protocol, [['all', 'All'], ['tcp', 'TCP'], ['udp', 'UDP']]) + '</div>' +
    '<label class="network-search">Search listening ports<input id="network-filter" class="field" type="search" value="' + esc(filter) + '" placeholder="Address, port or process…"></label><p class="muted">Process names are visible only when permitted for this user.</p>' +
    (ports ? table(['Protocol', 'State', 'Local address', 'Peer', 'Process'], ports.map(p => '<tr data-protocol="' + esc(text(p.protocol)) + '" data-q="' + esc([p.protocol,p.state,p.local,p.peer,p.process].map(text).join(' ').toLowerCase()) + '"><td>' + show(p.protocol) + '</td><td>' + show(p.state) + '</td><td>' + show(p.local) + '</td><td>' + show(p.peer) + '</td><td>' + show(p.process) + '</td></tr>').join('')) + '<p id="network-no-ports" class="muted"' + (ports.length ? ' hidden' : '') + '>No listening ports match this filter.</p>' : unavailable) + '</article>' +
    '<article id="network-firewall" class="card full"><div class="card-top"><h2>Firewall</h2><span class="tag">' + firewallState + '</span></div>' +
    table(['Service', 'State'], ['ufw', 'nftables', 'firewalld'].map(k => '<tr><td>' + k + '</td><td>' + (text(firewall[k]) ? show(firewall[k]) : 'Unavailable') + '</td></tr>').join('')) + '<p>firewall-cmd: ' + (text(firewall.firewalldState) ? show(firewall.firewalldState) : 'Unavailable') + '</p><p class="muted">Permission needed to read rules. Service state does not indicate which rules are loaded.</p></article>' +
    '<article id="network-tailscale" class="card full"><div class="card-top"><h2>Tailscale</h2></div>' +
    (tailscale ? table(['Host', 'Addresses', 'State', 'OS', 'Last seen'], nodeRow(tailscale.Self, true) + tailscale.peers.map(p => nodeRow(p)).join('')) : unavailable) + '</article></section>';
}
function applyFilter(el) {
  let visible = 0;
  el.querySelectorAll('#network-ports tbody tr').forEach(row => {
    row.hidden = !row.dataset.q.includes(filter.toLowerCase()) || protocol !== 'all' && protocol !== row.dataset.protocol;
    if (!row.hidden) visible++;
  });
  const empty = el.querySelector('#network-no-ports');
  if (empty) empty.hidden = visible > 0;
}
export function mount(el) {
  events = new AbortController();
  el.addEventListener('input', e => { if (e.target.id === 'network-filter') { filter = e.target.value; applyFilter(el); } }, {signal: events.signal});
  el.addEventListener('click', e => {
    const button = e.target.closest('button[data-protocol]');
    if (!button) return;
    protocol = button.dataset.protocol;
    el.querySelectorAll('button[data-protocol]').forEach(b => { b.classList.toggle('on', b === button); b.setAttribute('aria-pressed', String(b === button)); });
    applyFilter(el);
  }, {signal: events.signal});
  el.querySelectorAll('button[data-protocol]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.protocol === protocol)));
  applyFilter(el);
}
export function dispose() { events?.abort(); }
