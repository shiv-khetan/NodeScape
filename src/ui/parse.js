export function sections(txt) {
  const out = {};
  let key;
  for (const line of txt.split('\n')) {
    // Section header; cron's "@reboot cmd" has a space so isn't one.
    if (/^@\w+$/.test(line.trim())) out[(key = line.trim().slice(1))] = [];
    else if (key && line.trim()) out[key].push(line);
  }
  return out;
}

export const words = l => l.trim().split(/\s+/);

function parseUnits(lines = []) {
  return lines
    .map(l => { const [unit, load, active, sub, ...d] = words(l); return { unit, load, active, sub, desc: d.join(' ') }; })
    .filter(u => u.load === 'loaded');
}

export function parseTemps(lines = []) {
  const text = lines.join('\n').trim();
  if (text.startsWith('{')) {
    try {
      const temps = [];
      for (const [chip, features] of Object.entries(JSON.parse(text))) {
        if (!features || typeof features !== 'object') continue;
        for (const [label, readings] of Object.entries(features)) {
          if (!readings || typeof readings !== 'object') continue;
          for (const [key, celsius] of Object.entries(readings)) {
            if (!/^temp\d+_input$/.test(key) || !Number.isFinite(celsius)) continue;
            const prefix = key.replace(/_input$/, '');
            const temp = { label: chip + ' · ' + label, celsius };
            if (Number.isFinite(readings[prefix + '_max'])) temp.high = readings[prefix + '_max'];
            if (Number.isFinite(readings[prefix + '_crit'])) temp.crit = readings[prefix + '_crit'];
            temps.push(temp);
          }
        }
      }
      return temps;
    } catch { return []; }
  }
  const temps = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const value = lines[i + 1].trim();
    if (/^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(+value)) {
      temps.push({ label: lines[i].trim(), celsius: +value / 1000 });
    }
  }
  return temps;
}

export function journalLimited(groups, text = '') {
  return groups?.length ? !groups.some(g => ['adm', 'systemd-journal', 'root'].includes(g))
    : /not seeing messages from other users/.test(text);
}

// Count default-route links, excluding tunnels when no default route is available.
const VIRTUAL = /^(lo|tailscale|wg|tun|tap|docker|veth|br-|virbr)/;
function netCounters(lines = [], devs = []) {
  const counters = new Map();
  for (const line of lines) {
    const [name, rest] = line.split(':');
    const n = name.trim();
    if (!rest || (devs.length ? !devs.includes(n) : VIRTUAL.test(n))) continue;
    const f = words(rest).map(Number);
    counters.set(n, [f[0], f[8]]);
  }
  return counters;
}
function netRate(first, last, index) {
  if (!first.size || first.size !== last.size) return null;
  let delta = 0;
  for (const [dev, counters] of first) {
    const a = counters[index], b = last.get(dev)?.[index];
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < a) return null;
    delta += b - a;
  }
  return delta * 2; // sampled 0.5s apart
}

export function parseSnapshot(txt, fallbackHost) {
  const s = sections(txt);
  const [a, b] = (s.cpu || []).map(l => words(l).slice(1, 9).map(Number));
  let cpu = null;
  if (a?.length === 8 && b?.length === 8 && a.every((v, i) => Number.isFinite(v) && v >= 0 && Number.isFinite(b[i]) && b[i] >= v)) {
    const delta = b.map((v, i) => v - a[i]);
    const total = delta.reduce((sum, v) => sum + v, 0);
    if (total > 0) cpu = 100 * (1 - (delta[3] + delta[4]) / total);
  }
  const row = name => {
    const line = (s.mem || []).find(l => l.trim().startsWith(name));
    return line ? words(line).slice(1).map(Number) : [];
  };
  const devs = (s.gw || []).map(l => l.match(/\bdev (\S+)/)?.[1]).filter(Boolean);
  const first = netCounters(s.rx1, devs), last = netCounters(s.rx2, devs);
  return {
    host: s.host?.[0]?.trim() || fallbackHost,
    os: s.os?.[0], kernel: s.kernel?.[0],
    // The address this SSH session reached, rather than the first LAN address.
    ip: words(s.conn?.[0] || '')[2] || words(s.ip?.[0] || '')[0] || '',
    up: parseFloat(s.uptime?.[0]) || 0,
    load: [0, 1, 2].map(i => {
      const value = words(s.load?.[0] || '')[i];
      return value && Number.isFinite(+value) && +value >= 0 ? +value : null;
    }),
    cpus: /^\d+$/.test(s.cpus?.[0]?.trim()) && +s.cpus[0] > 0 ? +s.cpus[0] : null,
    cpu, mem: row('Mem:'), swap: row('Swap:'),
    rx: netRate(first, last, 0), tx: netRate(first, last, 1),
    disks: (s.disk || []).map(l => {
      // Target is last so mount points may contain spaces.
      const match = l.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return match ? { target: match[3], size: +match[1], used: +match[2] } : null;
    }).filter(d => d && Number.isFinite(d.size) && Number.isFinite(d.used) && d.size > 0 && d.used <= d.size),
    temps: parseTemps(s.temps),
    groups: s.groups?.flatMap(words).filter(Boolean) || null,
    net: (s.net || []).map(words),
    units: parseUnits(s.svc),
    log: (s.log || []).filter(l => /^\d{4}-\d\d-\d\dT/.test(l)),
    journalLimited: journalLimited(s.groups?.flatMap(words), (s.log || []).join('\n')),
  };
}

export const parseLog = l => {
  const m = l.match(/^(\S+)\s+\S+\s+([^:]+):\s?(.*)$/);
  return m ? { time: m[1].slice(11, 19), unit: m[2], msg: m[3] } : { time: '', unit: '', msg: l };
};
export const isErr = s => /error|fail|fatal|denied|panic|critical/i.test(s);

export function temperatureLabels(temps) {
  const short = label => label.split(' · ').at(-1).replace(/^Package id \d+$/, 'Package');
  return temps.map(t => {
    const label = short(t.label);
    return temps.filter(other => short(other.label) === label).length > 1 ? t.label : label;
  });
}
