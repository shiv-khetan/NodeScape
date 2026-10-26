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

export function parseSnapshot(txt, fallbackHost) {
  const s = sections(txt);
  const [a, b] = (s.cpu || []).map(l => words(l).slice(1, 9).map(Number));
  const tot = x => x.reduce((p, c) => p + c, 0), idle = x => x[3] + x[4];
  const cpu = a && b ? Math.max(0, Math.min(100, 100 * (1 - (idle(b) - idle(a)) / (tot(b) - tot(a) || 1)))) : 0;
  const row = name => words((s.mem || []).find(l => l.startsWith(name)) || `${name} 0 0 0 0 0 0`).slice(1).map(Number);
  const devs = (s.gw || []).map(l => l.match(/\bdev (\S+)/)?.[1]).filter(Boolean);
  const [r1, t1] = netSum(s.rx1, devs), [r2, t2] = netSum(s.rx2, devs);
  return {
    host: s.host?.[0]?.trim() || fallbackHost,
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

export const parseLog = l => {
  const m = l.match(/^(\S+)\s+\S+\s+([^:]+):\s?(.*)$/);
  return m ? { time: m[1].slice(11, 19), unit: m[2], msg: m[3] } : { time: '', unit: '', msg: l };
};
export const isErr = s => /error|fail|fatal|denied|panic|critical/i.test(s);

