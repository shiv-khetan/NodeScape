// ponytail: fake server behind the "demo" host (and when src/ is opened in a plain browser).
// It emits the same raw text the real SSH scripts return, so the parsers get exercised. Delete once real servers are in use.
(() => {
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const GB = 2 ** 30;
  const units = [
    ['caddy.service', 'Caddy web server', 'running'],
    ['docker.service', 'Docker Application Container Engine', 'running'],
    ['jellyfin.service', 'Jellyfin Media Server', 'running'],
    ['smbd.service', 'Samba SMB Daemon', 'running'],
    ['backup.service', 'Nightly restic backup', 'failed'],
    ['ssh.service', 'OpenBSD Secure Shell server', 'running'],
    ['cron.service', 'Regular background program processing daemon', 'running'],
    ['tailscaled.service', 'Tailscale node agent', 'running'],
    ['pihole-FTL.service', 'Pi-hole FTL DNS', 'running'],
    ['home-assistant.service', 'Home Assistant', 'running'],
    ['postgresql.service', 'PostgreSQL RDBMS', 'running'],
    ['syncthing@media.service', 'Syncthing for media', 'running'],
    ['zfs-scrub.service', 'ZFS pool scrub', 'failed'],
    ['apt-daily.service', 'Daily apt download activities', 'dead'],
    ['fstrim.service', 'Discard unused blocks on filesystems', 'dead'],
    ['nfs-server.service', 'NFS server and services', 'dead'],
  ].map(([unit, desc, sub]) => ({ unit, desc, sub }));
  const active = u => (u.sub === 'running' ? 'active' : u.sub === 'failed' ? 'failed' : 'inactive');

  const msgs = [
    ['systemd[1]', 'Started backup.service - Nightly restic backup.'],
    ['restic[8812]', 'Fatal: unable to open repository at sftp:backup@vault'],
    ['systemd[1]', "backup.service: Failed with result 'exit-code'."],
    ['sshd[9001]', 'Accepted publickey for admin from 192.168.1.5 port 52211 ssh2'],
    ['CRON[9020]', '(root) CMD (/usr/local/bin/sync-photos)'],
    ['jellyfin[1200]', 'Scheduled task "Scan Media Library" completed'],
    ['dockerd[880]', 'Container immich_server health check passed'],
    ['kernel', 'EXT4-fs (sdb1): mounted filesystem with ordered data mode'],
    ['pihole-FTL[640]', 'Blocked 1,204 queries in the last hour'],
    ['tailscaled[702]', 'magicsock: endpoints changed: 192.168.1.20:41641'],
    ['zed[512]', 'eid=48 class=scrub_finish pool=tank error: checksum'],
    ['caddy[701]', 'certificate obtained successfully for home.example.lan'],
  ];

  let cpu = 28, busy = 4e6, idle = 1.6e7, rx = 9e11, tx = 3e11, memUsed = 6.1 * GB, boot = Date.now() - 13.4 * 86400e3;
  const iso = t => new Date(t).toISOString().slice(0, 19) + '+0000';
  const logLine = (t, i) => { const [p, m] = msgs[i % msgs.length]; return `${iso(t)} nas-01 ${p}: ${m}`; };
  const netDev = () => `    lo: 9000000 1 0 0 0 0 0 0 9000000 1 0 0 0 0 0 0\nenp3s0: ${Math.round(rx)} 1 0 0 0 0 0 0 ${Math.round(tx)} 1 0 0 0 0 0 0`;
  const statLine = () => `cpu  ${Math.round(busy)} 0 0 ${Math.round(idle)} 0 0 0 0 0 0`;

  function snapshot() {
    cpu = clamp(cpu + rnd(-14, 14), 3, 94);
    memUsed = clamp(memUsed + rnd(-0.3, 0.3) * GB, 4 * GB, 12 * GB);
    const rx1 = netDev(), a = statLine();
    busy += cpu * 40; idle += (100 - cpu) * 40;
    rx += rnd(0.1, 5) * 2 ** 20 * 0.5; tx += rnd(0.05, 1.5) * 2 ** 20 * 0.5;
    const total = 32 * GB, cache = 11 * GB, free = total - memUsed - cache;
    const l1 = ((cpu / 100) * 8 * rnd(0.8, 1.1)).toFixed(2);
    return [
      '@host', 'nas-01', '@os', 'Debian GNU/Linux 12 (bookworm)', '@kernel', '6.1.0-26-amd64',
      '@ip', '192.168.1.20 100.101.7.3',
      '@uptime', `${(Date.now() - boot) / 1000} 0`,
      '@load', `${l1} 1.84 1.52 2/412 9911`, '@cpus', '8',
      '@mem', '              total        used        free      shared  buff/cache   available',
      `Mem: ${total} ${Math.round(memUsed)} ${Math.round(free)} 1 ${cache} ${Math.round(total - memUsed)}`,
      `Swap: ${4 * GB} ${0.6 * GB} ${3.4 * GB}`,
      '@disk', `/ ${240 * GB} ${131 * GB}`, `/srv/media ${7450 * GB} ${5310 * GB}`, `/srv/backup ${1860 * GB} ${1420 * GB}`, `/boot/efi ${0.5 * GB} ${0.01 * GB}`,
      '@net', 'lo UNKNOWN 127.0.0.1/8 ::1/128', 'enp3s0 UP 192.168.1.20/24', 'tailscale0 UP 100.101.7.3/32', 'docker0 DOWN 172.17.0.1/16',
      '@svc', ...units.map(u => `${u.unit} loaded ${active(u)} ${u.sub} ${u.desc}`),
      '@log', ...Array.from({ length: 12 }, (_, i) => logLine(Date.now() - (12 - i) * 47e3, i)),
      '@rx1', rx1, '@cpu', a, statLine(), '@rx2', netDev(),
      '@gw', 'default via 192.168.1.1 dev enp3s0 proto dhcp metric 100', '@conn', '100.101.7.9 52211 100.101.7.3 22',
    ].join('\n');
  }

  function processes() {
    const names = ['jellyfin', 'dockerd', 'postgres', 'python3', 'pihole-FTL', 'smbd', 'caddy', 'tailscaled', 'syncthing', 'node', 'containerd', 'sshd', 'systemd', 'cron', 'zed', 'rsyslogd'];
    const users = ['jellyfin', 'root', 'postgres', 'homeassistant', 'pihole', 'root', 'caddy', 'root', 'media', 'media', 'root', 'root', 'root', 'root', 'root', 'syslog'];
    return names.map((n, i) => `${1000 + i * 137} ${users[i]} ${(rnd(0, 30) / (i + 1)).toFixed(1)} ${(rnd(0.2, 9) / Math.sqrt(i + 1)).toFixed(1)} ${Math.floor(rnd(0, 13))}-0${Math.floor(rnd(0, 9))}:12:44 ${n}`)
      .sort((x, y) => parseFloat(y.split(' ')[2]) - parseFloat(x.split(' ')[2])).join('\n');
  }

  function timers() {
    const t = [
      ['apt-daily.timer', 'apt-daily.service', 'Thu 2026-10-23 06:12:00 UTC', 'Wed 2026-10-22 06:40:11 UTC'],
      ['backup.timer', 'backup.service', 'Thu 2026-10-23 02:30:00 UTC', 'Wed 2026-10-22 02:30:04 UTC'],
      ['fstrim.timer', 'fstrim.service', 'Mon 2026-10-26 00:00:00 UTC', 'Mon 2026-10-19 00:00:02 UTC'],
      ['zfs-scrub.timer', 'zfs-scrub.service', 'Sun 2026-11-01 03:00:00 UTC', 'Sun 2026-10-04 03:00:01 UTC'],
      ['logrotate.timer', 'logrotate.service', 'Thu 2026-10-23 00:00:00 UTC', 'Wed 2026-10-22 00:00:00 UTC'],
    ];
    return ['@timers', ...t.flatMap(([id, unit, next, last]) => [`Id=${id}`, `Unit=${unit}`, 'ActiveState=active', `NextElapseUSecRealtime=${next}`, `LastTriggerUSec=${last}`, '']),
      '@cron', '*/15 * * * * /usr/local/bin/sync-photos', '0 4 * * 0 docker system prune -f', '@reboot /usr/local/bin/mount-media'].join('\n');
  }

  function logs({ unit, lines }) {
    const all = Array.from({ length: 400 }, (_, i) => logLine(Date.now() - (400 - i) * 31e3, i * 7));
    const name = (unit || '').replace(/\.service$/, '').split(/[@.]/)[0];
    const hit = name ? all.filter(l => l.toLowerCase().includes(name.toLowerCase())) : all;
    return (hit.length ? hit : [`-- No entries for ${unit} --`]).slice(-lines).join('\n');
  }

  window.demoInvoke = async (cmd, args = {}) => {
    await new Promise(r => setTimeout(r, rnd(120, 400)));
    if (cmd === 'hosts') return [];
    if (cmd === 'logs') return logs(args);
    if (cmd === 'service_action') {
      const u = units.find(x => x.unit === args.unit);
      if (u) u.sub = args.action === 'stop' ? 'dead' : args.action.endsWith('start') ? 'running' : u.sub;
      return 'ok';
    }
    return { snapshot, processes, timers }[args.what]();
  };

  // Pre-filled history so charts aren't empty on first open.
  window.demoHistory = () => {
    let c = 30;
    return {
      cpu: Array.from({ length: 48 }, () => (c = clamp(c + rnd(-12, 12), 4, 90))),
      rx: Array.from({ length: 14 }, () => rnd(0.2, 5) * 2 ** 20),
      tx: Array.from({ length: 14 }, () => rnd(0.05, 1.5) * 2 ** 20),
    };
  };
})();
