// Fake server output in the exact format the SSH scripts in src-tauri/src/main.rs produce.
// All names and addresses are made up.

const GiB = 2 ** 30;

// Network: eth0 (default route) moves 512 KiB in / 256 KiB out during the 0.5s sample,
// i.e. 1.0 MB/s in and 512 KB/s out. tailscale0 also moves traffic but must be ignored,
// because tunnel traffic is already counted on the physical link.
const dev = (eth, ts) =>
  [`    lo: 500 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0`,
   `  eth0: ${eth[0]} 0 0 0 0 0 0 0 ${eth[1]} 0 0 0 0 0 0 0`,
   `tailscale0: ${ts[0]} 0 0 0 0 0 0 0 ${ts[1]} 0 0 0 0 0 0 0`].join('\n');

const SNAPSHOT = [
  '@rx1', dev([1_000_000, 2_000_000], [1_000_000, 1_000_000]),
  // busy +100, idle +100 → 50% CPU
  '@cpu', 'cpu  100 0 100 800 0 0 0 0 0 0', 'cpu  150 0 150 900 0 0 0 0 0 0',
  '@rx2', dev([1_524_288, 2_262_144], [9_000_000, 9_000_000]),
  '@gw', 'default via 10.0.0.1 dev eth0 proto dhcp metric 100',
  '@conn', '10.0.0.5 50000 10.0.0.2 22',
  '@host', 'testbox',
  '@os', 'Debian GNU/Linux 12 (bookworm)',
  '@kernel', '6.1.0-test',
  '@ip', '192.168.50.2 10.0.0.2',
  '@uptime', '90061.00 0.00', // 1d 1h 1m
  '@load', '0.50 0.40 0.30 1/100 999',
  '@cpus', '4',
  '@mem', '               total        used        free      shared  buff/cache   available',
  // 16 GiB total, 12 GiB available → 4 GiB (25%) used
  `Mem: ${16 * GiB} ${4 * GiB} ${4 * GiB} 0 ${8 * GiB} ${12 * GiB}`,
  `Swap: ${2 * GiB} 0 ${2 * GiB}`,
  '@disk', `/ ${100 * GiB} ${50 * GiB}`,
  '@net', 'lo UNKNOWN 127.0.0.1/8', 'eth0 UP 10.0.0.2/24', 'tailscale0 UNKNOWN 100.64.0.2/32', 'docker0 DOWN 172.17.0.1/16',
  '@svc',
  'nginx.service loaded active running Web server',
  'backup.service loaded failed failed Backup job',
  'cron.service loaded active running Cron daemon',
  'gone.service not-found inactive dead gone.service',
  '@log',
  '2026-01-01T10:00:00+00:00 testbox sshd[42]: Accepted publickey for admin',
  '2026-01-01T10:01:00+00:00 testbox backup[77]: error: repository unreachable',
].join('\n');

const TIMERS_NO_CRON = [
  '@timers',
  'Id=backup.timer', 'Unit=backup.service', 'ActiveState=active',
  'NextElapseUSecRealtime=Thu 2026-01-02 02:00:00 UTC', 'LastTriggerUSec=Wed 2026-01-01 02:00:00 UTC', '',
  'Id=fstrim.timer', 'Unit=fstrim.service', 'ActiveState=active', 'NextElapseUSecRealtime=', 'LastTriggerUSec=',
  '@cron',
].join('\n');

// What journalctl prints for a user who is not in adm/systemd-journal (stderr merged in).
const LOGS_LIMITED = [
  'Hint: You are currently not seeing messages from other users and the system.',
  "      Users in groups 'adm', 'systemd-journal' can see all messages.",
  '      Pass -q to turn off this notice.',
  '2026-01-01T09:00:00+00:00 testbox systemd[900]: Started session.',
  '-- Boot 0123456789abcdef --',
  '2026-01-01T10:00:00+00:00 testbox systemd[900]: Reached target default.target.',
  '2026-01-01T10:05:00+00:00 testbox app[901]: fatal: config missing',
].join('\n');

const PROCESSES = [
  '  101 www-data  12.5  3.1    01:02:03 nginx',
  '  202 root       2.0  0.5    10:00 cron',
].join('\n');

module.exports = { SNAPSHOT, TIMERS_NO_CRON, LOGS_LIMITED, PROCESSES };
