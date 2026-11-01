window.installDemoBackend = ({ responses = null, host = 'nas-01', profiles: initialProfiles } = {}) => {
  if (host !== null) localStorage.setItem('host', host);
  window.__calls = [];
  window.__pending = [];
  let seed = 123456789;
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
  const now = 1793059200000;
  const rnd = (a, b) => a + random() * (b - a);
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
  ].map(([unit, desc, sub]) => ({ unit, desc, sub, enabled: sub === 'running' ? 'enabled' : 'disabled' }));
  const active = u => (u.sub === 'running' ? 'active' : u.sub === 'failed' ? 'failed' : 'inactive');

  const msgs = [
    ['systemd[1]', 'Started backup.service - Nightly restic backup.'],
    ['restic[8812]', 'Fatal: unable to open repository at sftp:backup@vault'],
    ['systemd[1]', "backup.service: Failed with result 'exit-code'."],
    ['sshd[9001]', 'Accepted publickey for admin from 10.0.0.5 port 52211 ssh2'],
    ['CRON[9020]', '(root) CMD (/usr/local/bin/sync-photos)'],
    ['jellyfin[1200]', 'Scheduled task "Scan Media Library" completed'],
    ['dockerd[880]', 'Container immich_server health check passed'],
    ['kernel', 'EXT4-fs (sdb1): mounted filesystem with ordered data mode'],
    ['pihole-FTL[640]', 'Blocked 1,204 queries in the last hour'],
    ['tailscaled[702]', 'magicsock: endpoints changed: 10.0.0.2:41641'],
    ['zed[512]', 'eid=48 class=scrub_finish pool=tank error: checksum'],
    ['caddy[701]', 'certificate obtained successfully for home.example.lan'],
  ];

  let cpu = 28, busy = 4e6, idle = 1.6e7, rx = 9e11, tx = 3e11, memUsed = 6.1 * GB, boot = now - 13.4 * 86400e3;
  const iso = t => new Date(t).toISOString().slice(0, 19) + '+0000';
  const logLine = (t, i) => { const [p, m] = msgs[i % msgs.length]; return `${iso(t)} nas-01 ${p}: ${m}`; };
  const netDev = () => `    lo: 9000000 1 0 0 0 0 0 0 9000000 1 0 0 0 0 0 0\nenp3s0: ${Math.round(rx)} 1 0 0 0 0 0 0 ${Math.round(tx)} 1 0 0 0 0 0 0`;
  const statLine = () => `cpu  ${Math.round(busy)} 0 0 ${Math.round(idle)} 0 0 0 0 0 0`;

  // Each snapshot advances the server clock by the 0.5 s its counters move, so quick deltas match full samples.
  let clock = 0;
  function snapshot(quick = false) {
    clock += 0.5;
    cpu = clamp(cpu + rnd(-14, 14), 3, 94);
    memUsed = clamp(memUsed + rnd(-0.3, 0.3) * GB, 4 * GB, 12 * GB);
    const rx1 = netDev(), a = statLine();
    busy += cpu * 40; idle += (100 - cpu) * 40;
    rx += rnd(0.1, 5) * 2 ** 20 * 0.5; tx += rnd(0.05, 1.5) * 2 ** 20 * 0.5;
    const total = 32 * GB, cache = 11 * GB, free = total - memUsed - cache;
    const l1 = ((cpu / 100) * 8 * rnd(0.8, 1.1)).toFixed(2);
    return [
      '@host', 'nas-01', '@os', 'Debian GNU/Linux 12 (bookworm)', '@kernel', '6.1.0-26-amd64',
      '@ip', '10.0.0.2 10.0.0.3',
      '@uptime', `${(now - boot) / 1000 + clock} 0`,
      '@load', `${l1} 1.84 1.52 2/412 9911`, '@cpus', '8',
      '@mem', '              total        used        free      shared  buff/cache   available',
      `Mem: ${total} ${Math.round(memUsed)} ${Math.round(free)} 1 ${cache} ${Math.round(total - memUsed)}`,
      `Swap: ${4 * GB} ${0.6 * GB} ${3.4 * GB}`,
      '@disk', `${240 * GB} ${131 * GB} /`, `${7450 * GB} ${5310 * GB} /srv/media`, `${1860 * GB} ${1420 * GB} /srv/backup`, `${0.5 * GB} ${0.01 * GB} /boot/efi`,
      '@temps', JSON.stringify({ 'coretemp-isa-0000': { 'Package id 0': { temp1_input: 56, temp1_max: 80, temp1_crit: 100 }, 'Core 0': { temp2_input: 48, temp2_max: 80, temp2_crit: 100 } } }),
      '@groups', 'testuser adm',
      '@net', 'lo UNKNOWN 127.0.0.1/8 ::1/128', 'enp3s0 UP 10.0.0.2/24', 'tailscale0 UP 10.0.0.3/32', 'docker0 DOWN 172.17.0.1/16',
      '@svc', ...units.map(u => `${u.unit} loaded ${active(u)} ${u.sub} ${u.desc}`),
      '@log', ...Array.from({ length: 12 }, (_, i) => logLine(now - (12 - i) * 47e3, i)),
      '@rx1', rx1, '@cpu', a, ...(quick ? [] : [statLine(), '@rx2', netDev()]),
      '@gw', 'default via 10.0.0.1 dev enp3s0 proto dhcp metric 100', '@conn', '10.0.0.9 52211 10.0.0.3 22',
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
    const all = Array.from({ length: 400 }, (_, i) => logLine(now - (400 - i) * 31e3, i * 7));
    const name = (unit || '').replace(/\.service$/, '').split(/[@.]/)[0];
    const hit = name ? all.filter(l => l.toLowerCase().includes(name.toLowerCase())) : all;
    return (hit.length ? hit : [`-- No entries for ${unit} --`]).slice(-lines).join('\n');
  }

  let savedProfiles = initialProfiles ?? (host && host !== 'demo' ? [...new Set([host, 'testbox', 'nas-01'])].map(h => ({ id:h, name:h, host:h, config:null })) : []);
  // Persist across reloads to exercise the once-only localStorage migration.
  try { savedProfiles = JSON.parse(sessionStorage.getItem('fixtureProfiles')) ?? savedProfiles; } catch {}
  const persistProfiles = () => sessionStorage.setItem('fixtureProfiles', JSON.stringify(savedProfiles));
  async function onboardingFixture(cmd, args) {
    const supplied = responses?.[cmd];
    if (supplied?.error) throw supplied.error;
    if (supplied !== undefined) return supplied;
    if (cmd === 'profiles_list') return { profiles:savedProfiles, warning:null };
    if (cmd === 'profile_save') {
      const profile = {...args.profile};
      if (savedProfiles.some(p => p.id !== profile.id && p.name.toLowerCase() === profile.name.toLowerCase())) throw {kind:'invalid_input',message:'Server names must be unique'};
      profile.id ||= 'profile-' + (savedProfiles.length+1);
      const index = savedProfiles.findIndex(p=>p.id===profile.id); if(index<0) savedProfiles.push(profile); else savedProfiles[index]=profile; persistProfiles(); return profile;
    }
    if (cmd === 'profile_remove') { savedProfiles=savedProfiles.filter(p=>p.id!==args.id); persistProfiles(); return null; }
    if (cmd === 'ssh_config_save') return {host:args.server.alias,config:'C:/synthetic/app/ssh_config'};
    if (cmd === 'environment_check') return {ssh:{path:'C:/synthetic/ssh.exe',version:'OpenSSH_9.9',error:null},sshKeygen:{path:'C:/synthetic/ssh-keygen.exe',version:'OpenSSH_9.9 (ssh-keygen)',error:null},sshDirExists:true,publicKeys:['id_ed25519.pub']};
    if (cmd === 'public_key_read') return 'ssh-ed25519 AAAA nodescape';
    if (cmd === 'connection_test') return null;
    if (cmd === 'plugin:dialog|open') return args.options.title === 'Choose SSH config' ? 'C:/synthetic/ssh config' : 'C:/synthetic/key with spaces';
  }
  const terminalSessions = new Map();
  let terminalNext = 0;
  class FakeChannel { constructor(onmessage) { this.onmessage = onmessage; } }
  window.__terminalEmit = (id, text) => {
    const session = terminalSessions.get(id);
    if (!session) return;
    const data = Array.from(new TextEncoder().encode(text));
    session.unacked += data.length;
    session.channel.onmessage({ kind: 'output', id, host: session.host, data });
  };
  window.__terminalExit = (id, code = 0) => {
    const session = terminalSessions.get(id);
    if (session) session.channel.onmessage({ kind: 'exit', id, host: session.host, code, error: null });
  };
  async function terminalCommand(cmd, args) {
    const response = responses?.[cmd];
    if (response?.defer) await new Promise(resolve => window.__pending.push(resolve));
    const result = response?.defer ? response.value : response;
    if (result?.error) throw result.error;
    if (cmd === 'terminal_open' || cmd === 'terminal_open_kind') {
      const id = 'terminal-' + ++terminalNext;
      terminalSessions.set(id, { channel: args.channel, host: args.target.host, unacked: 0 });
      window.__terminalEmit(id, cmd === 'terminal_open_kind' ? (args.kind === 'trust_host' ? 'ED25519 key fingerprint is SHA256:synthetic. Continue connecting (yes/no)? ' : args.kind === 'keygen' ? 'Enter passphrase: ' : 'Password: ') : 'Connected to ' + args.target.host + '\r\n$ ');
      return id;
    }
    if (cmd === 'terminal_close') { window.__terminalExit(args.id); terminalSessions.delete(args.id); return null; }
    const session = terminalSessions.get(args.id);
    if (!session) throw { kind: 'not_found', message: 'Terminal session is closed' };
    if (cmd === 'terminal_input') { window.__terminalEmit(args.id, args.data.replace(/\r/g, '\r\n$ ')); return null; }
    if (cmd === 'terminal_resize') return null;
    if (cmd === 'terminal_ack') {
      if (args.bytes <= 0 || args.bytes > session.unacked) throw { kind: 'invalid_input', message: 'Invalid terminal acknowledgement' };
      session.unacked -= args.bytes;
      return null;
    }
    throw { kind: 'invalid_input', message: 'Unknown terminal command' };
  }

  // Deterministic SFTP / native picker fixture; no production fallback.
  const files = new Map(), transferJobs = new Map();
  const putFile = (path, kind = 'file', text = '', linkTarget) => files.set(path, {
    name: path.split('/').pop(), kind, size: new TextEncoder().encode(text).length,
    mtime: 1793059200, mode: kind === 'dir' ? 0o40755 : kind === 'symlink' ? 0o120777 : 0o100644, text, linkTarget,
  });
  putFile('/documents', 'dir'); putFile('/documents/note.txt', 'file', 'notes');
  putFile('/ü ñ 文件 test.txt', 'file', 'hello ü ñ 文件');
  putFile('/shortcut', 'symlink', '', '/documents'); putFile('/dangling', 'symlink', '', '/missing');
  putFile('/<img src=x onerror=alert(1)>', 'file', 'untrusted name');
  const fileError = (kind, message) => { throw { kind, message }; };
  const requireFile = path => files.get(path) || fileError('not_found', 'File not found');
  window.__finishTransfers = () => { for (const finish of [...transferJobs.values()]) finish.complete(); };
  const fileSha256 = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');
  async function filesFixture(cmd, args) {
    const path = args.path;
    if (cmd === 'plugin:dialog|open') return 'C:\\synthetic\\upload.txt';
    if (cmd === 'plugin:dialog|save') return 'C:\\synthetic\\' + args.options.defaultPath;
    if (cmd === 'operation_cancel') { const job = transferJobs.get(args.id); if (job) { transferJobs.delete(args.id); job.reject({ kind: 'cancelled', message: 'Transfer cancelled' }); } return !!job; }
    if (cmd === 'files_home') return '/';
    if (cmd === 'files_list') {
      if (path === '/denied') fileError('permission_denied', 'Permission denied');
      if (path !== '/' && requireFile(path).kind !== 'dir') fileError('remote', 'Not a directory');
      const prefix = path === '/' ? '/' : path + '/';
      return [...files].filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/')).map(([,entry]) => ({ ...entry }));
    }
    if (cmd === 'file_mkdir' || cmd === 'file_create') {
      if (files.has(path)) fileError('conflict', 'Destination already exists');
      putFile(path, cmd === 'file_mkdir' ? 'dir' : 'file'); return null;
    }
    if (cmd === 'file_rename') {
      requireFile(args.from); if (files.has(args.to)) fileError('conflict', 'Destination already exists');
      for (const [key, entry] of [...files]) if (key === args.from || key.startsWith(args.from + '/')) {
        const dest = args.to + key.slice(args.from.length); files.delete(key); files.set(dest, { ...entry, name: dest.split('/').pop() });
      }
      return null;
    }
    if (cmd === 'file_delete') {
      const entry = requireFile(path), children = [...files.keys()].filter(key => key.startsWith(path + '/'));
      if (entry.kind === 'dir' && children.length && !args.recursive) fileError('remote', 'Directory is not empty. Recursive deletion requires confirmation.');
      files.delete(path); if (args.recursive && entry.kind === 'dir') for (const key of children) files.delete(key); return null;
    }
    if (cmd === 'file_read_text') {
      const entry = requireFile(path); return { text: entry.text, mtime: entry.mtime, size: entry.size, sha256: await fileSha256(entry.text) };
    }
    if (cmd === 'file_write_text') {
      const entry = requireFile(path);
      if (await fileSha256(entry.text) !== args.expectedSha256) fileError('conflict', 'File changed on the server. Your edits have been kept.');
      entry.text = args.text; entry.size = new TextEncoder().encode(args.text).length; entry.mtime++; return null;
    }
    if (cmd === 'transfer_start') return new Promise((resolve, reject) => {
      args.channel.onmessage({ bytes: 0, total: 4 * 1024 * 1024 });
      args.channel.onmessage({ bytes: 1024 * 1024, total: 4 * 1024 * 1024 });
      transferJobs.set(args.operationId, { reject, complete: () => {
        args.channel.onmessage({ bytes: 4 * 1024 * 1024, total: 4 * 1024 * 1024 });
        if (args.direction === 'up') putFile(args.remotePath, 'file', 'uploaded');
        transferJobs.delete(args.operationId); resolve(null);
      } });
    });
    fileError('invalid_input', 'Unknown file command');
  }

  const userUnits = [{ unit: 'sync.service', desc: 'Personal sync', sub: 'dead', enabled: 'disabled' }];
  function servicesFixture(target) {
    // Older suites supply a snapshot; adapt it only inside this test fixture.
    const supplied = responses?.[target.host + ':snapshot'] ?? responses?.snapshot;
    const listed = typeof supplied === 'string' ? supplied.split('@svc\n')[1]?.split('\n@')[0].split('\n').map(line => {
      const [unit, load, active, sub, ...description] = line.trim().split(/\s+/);
      return { unit, load, active, sub, desc: description.join(' '), enabled: 'enabled' };
    }).filter(u => u.unit?.endsWith('.service')) || [] : units;
    const convert = u => ({ name: u.unit, load: u.load || 'loaded', active: u.active || active(u), sub: u.sub, description: u.desc, enabled: u.enabled });
    return { system: { units: listed.map(convert) }, user: { available: true, units: userUnits.map(convert) } };
  }

  // Accounts fixture: mutations are confined to this in-memory fake host.
  const accounts = {
    currentUser: 'operator', sudoGroups: ['sudo'],
    users: [
      { name: 'root', uid: 0, gid: 0, home: '/root', shell: '/bin/bash', groups: ['root'], system: true, login: true },
      { name: 'alice', uid: 1000, gid: 1000, home: '/home/alice', shell: '/bin/bash', groups: ['alice', 'sudo', 'team'], system: false, login: true },
      { name: 'operator', uid: 1001, gid: 1001, home: '/home/operator', shell: '/bin/bash', groups: ['operator', 'team'], system: false, login: true },
      { name: 'daemon', uid: 2, gid: 2, home: '/', shell: '/usr/sbin/nologin', groups: ['daemon'], system: true, login: false },
      { name: 'nobody', uid: 65534, gid: 65534, home: '/', shell: '/bin/false', groups: [], system: true, login: false },
    ],
    groups: [{ name: 'root', gid: 0, members: [] }, { name: 'alice', gid: 1000, members: [] }, { name: 'operator', gid: 1001, members: [] }, { name: 'sudo', gid: 27, members: ['alice'] }, { name: 'team', gid: 2000, members: ['alice', 'operator'] }, { name: 'extra', gid: 2001, members: [] }],
  };
  function accountsFixture(cmd, { action, args = {}, password }) {
    if (cmd === 'accounts_read') return structuredClone(accounts);
    if (window.__accountsActionError) throw window.__accountsActionError;
    const user = accounts.users.find(u => u.name === args.name);
    if (action === 'create_user' && user) throw { kind: 'conflict', message: 'User already exists' };
    if (['delete_user', 'remove_from_group'].includes(action) && user && (user.system || user.name === accounts.currentUser)) throw { kind: 'permission_denied', message: 'Refused: protected account' };
    if (password == null) throw { kind: 'sudo_required', message: 'sudo: a password is required' };
    if (action === 'create_user') {
      accounts.users.push({ name: args.name, uid: 1100, gid: 1100, home: '/home/' + args.name, shell: '/bin/bash', groups: [args.name, ...(args.groups || [])], system: false, login: true });
      accounts.groups.push({ name: args.name, gid: 1100, members: [] });
      for (const group of accounts.groups) if (args.groups?.includes(group.name)) group.members.push(args.name);
    } else if (action === 'delete_user') {
      accounts.users = accounts.users.filter(u => u.name !== args.name);
      for (const group of accounts.groups) group.members = group.members.filter(n => n !== args.name);
    } else {
      const group = accounts.groups.find(g => g.name === args.group);
      if (!user || !group) throw { kind: 'not_found', message: 'User or group not found' };
      if (action === 'add_to_group') { user.groups = [...new Set([...user.groups, args.group])]; group.members = [...new Set([...group.members, args.name])]; }
      else if (action === 'remove_from_group') { user.groups = user.groups.filter(g => g !== args.group); group.members = group.members.filter(n => n !== args.name); }
      else throw { kind: 'invalid_input', message: 'Unknown account action' };
    }
    return 'ok';
  }

  window.__TAURI__ = { core: { Channel: FakeChannel, invoke: async (cmd, args = {}) => {
    window.__calls.push({ cmd, args: ['service_action', 'account_action'].includes(cmd) && args.password != null ? { ...args, password: '[redacted]' }
      : cmd === 'login_password_set' ? { login: { ...args.login, password: '[redacted]' } } : args });
    if (cmd === 'login_password_set') { const r = responses?.login_password_set; if (r?.error) throw r.error; return null; }
    if (cmd === 'login_password_forget') return null;
    if (cmd === 'login_password_saved') return responses?.login_password_saved ?? false;
    if (cmd === 'connection_diagnose') return responses?.connection_diagnose ?? { ok: true, error: null, log: 'debug1: Authenticated to ' + args.target.host + ' using "publickey".' };
    if (cmd === 'sudo_status') return responses?.sudo_status ?? 'password';
    if (cmd === 'server_health') { const r = responses?.[args.target.host + ':server_health'] ?? responses?.server_health; if (r?.error) throw r.error; return r ?? { failed: 0 }; }
    if (cmd === 'accounts_read' && responses && responses.accounts_read === undefined) return accountsFixture(cmd, args);
    if (/^(profiles_list|profile_save|profile_remove|environment_check|ssh_config_save|public_key_read|connection_test)$/.test(cmd) || (cmd === 'plugin:dialog|open' && args.options.title !== 'Upload file')) return onboardingFixture(cmd, args);
    if (cmd.startsWith('terminal_')) return terminalCommand(cmd, args);
    if (/^(files_|file_|transfer_|plugin:dialog\|)/.test(cmd) || cmd === 'operation_cancel') return filesFixture(cmd, args);
    if (cmd === 'services_read' && responses?.[args.target.host + ':services_read'] === undefined && responses?.services_read === undefined) return servicesFixture(args.target);
    if (responses !== null) {
      const key = cmd === 'query' ? args.what : cmd;
      const pick = k => responses[(args.target?.host ?? args.host) + ':' + k] ?? responses[k];
      // Tests that supply a snapshot answer the quick variant with it too.
      const supplied = pick(key) ?? (key === 'snapshot_quick' ? pick('snapshot') : undefined);
      // A list of responses answers successive calls (the last one repeats).
      const value = (['service_action', 'account_action'].includes(cmd) || cmd === 'query') && Array.isArray(supplied) ? (supplied.length > 1 ? supplied.shift() : supplied[0]) : supplied;
      if (value?.defer) await new Promise(resolve => window.__pending.push(resolve));
      const result = value?.defer ? value.value : value;
      if (result?.error) throw result.error;
      return result ?? (cmd === 'hosts' ? ['nas-01', 'testbox'] : '');
    }
    if (cmd === 'accounts_read' || cmd === 'account_action') return accountsFixture(cmd, args);
    if (cmd === 'network_read') return {
  interfaces: [{ ifname: 'eth0', operstate: 'UP', addr_info: [{local:'192.0.2.2',prefixlen:24},{local:'2001:db8::2',prefixlen:64}] }, {ifname:'down0',operstate:'DOWN',addr_info:[]}],
  routes4: [{dst:'default',gateway:'192.0.2.1',dev:'eth0',metric:100},{dst:'default',gateway:'192.0.2.3',dev:'eth0',metric:200}],
  routes6: [{dst:'default',gateway:'fe80::1',dev:'eth0'},{dst:'2001:db8::/64',dev:'eth0'}],
  ports: [{protocol:'tcp',state:'LISTEN',local:'[::]:22',peer:'[::]:*',process:'sshd'},{protocol:'udp',state:'UNCONN',local:'0.0.0.0:53',peer:'0.0.0.0:*',process:''}],
  firewall: {ufw:'inactive',nftables:'active',firewalld:'inactive',firewalldState:'not running'},
  tailscale: {Self:{HostName:'selfbox',TailscaleIPs:['100.64.0.1'],Online:true,OS:'linux'},peers:[{HostName:'peerbox',TailscaleIPs:['fd7a::2'],Online:true,OS:'linux',LastSeen:'2026-10-01'},{HostName:'sleepbox',TailscaleIPs:[],Online:false,OS:'linux'}]}
};
    if (cmd === 'hosts') return ['nas-01', 'testbox'];
    if (cmd === 'cancel') return null;
    if (cmd === 'logs') return logs(args);
    if (cmd === 'service_action') {
      const u = (args.scope === 'user' ? userUnits : units).find(x => x.unit === args.unit);
      if (!u) throw { kind: 'not_found', message: 'Unknown service' };
      if (args.action === 'enable' || args.action === 'disable') u.enabled = args.action === 'enable' ? 'enabled' : 'disabled';
      else u.sub = args.action === 'stop' ? 'dead' : 'running';
      return 'ok';
    }
    const collect = cmd === 'query' && { snapshot, snapshot_quick: () => snapshot(true), processes, timers }[args.what];
    if (!collect) throw { kind: 'invalid_input', message: 'Unknown command' };
    return collect();
  } } };
};
