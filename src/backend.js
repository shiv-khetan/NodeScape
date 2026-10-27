/** @typedef {{host: string, config: string|null}} Target */
/** @typedef {{kind: string, message: string}} BackendError */

export const available = () => typeof window.__TAURI__?.core?.invoke === 'function';

async function invoke(command, args = {}) {
  try {
    if (!available()) throw { kind: 'internal', message: 'NodeScape needs its desktop app to run' };
    return await window.__TAURI__.core.invoke(command, args);
  } catch (error) {
    throw {
      kind: typeof error?.kind === 'string' ? error.kind : 'internal',
      message: String(error?.message ?? error).slice(0, 4000),
    };
  }
}

/** @param {Target} target @param {'snapshot'|'processes'|'timers'} what @returns {Promise<string>} */
export const query = (target, what) => invoke('query', { ...target, what });
/** @param {Target} target @param {string|null} unit @param {number} lines @returns {Promise<string>} */
export const logs = (target, unit = null, lines = 300) => invoke('logs', { ...target, unit, lines });
/** Read system and SSH account service units, including installed unit files. */
export const servicesRead = target => invoke('services_read', { target });
/** @param {Target} target @param {string} unit @param {'start'|'stop'|'restart'|'enable'|'disable'} action @param {string|null} [password] @param {'system'|'user'} [scope] @returns {Promise<string>} */
export const serviceAction = (target, unit, action, password, scope = 'system') => invoke('service_action', { target, scope, unit, action, ...(password === undefined ? {} : { password }) });
/** @param {string|null} config @returns {Promise<string[]>} */
export const hosts = (config = null) => invoke('hosts', { config });
/** @param {string} id @returns {Promise<void>} */
export const cancel = id => invoke('operation_cancel', { id });

/** Read-only network inspection. */
export const networkRead = target => invoke('network_read', { target });
// Channels stay in the adapter along with all other desktop IPC.
export function terminalChannel(onmessage) {
  const Channel = window.__TAURI__?.core?.Channel;
  if (!Channel) throw { kind: 'internal', message: 'Terminal channels require the desktop app' };
  return new Channel(onmessage);
}
export const terminalOpen = (target, cols, rows, channel) => invoke('terminal_open', { target, cols, rows, channel });
export const terminalInput = (id, data) => invoke('terminal_input', { id, data });
export const terminalResize = (id, cols, rows) => invoke('terminal_resize', { id, cols, rows });
export const terminalAck = (id, bytes) => invoke('terminal_ack', { id, bytes });
export const terminalClose = id => invoke('terminal_close', { id });

export const filesList = (target, path) => invoke('files_list', { target, path });
export const fileMkdir = (target, path) => invoke('file_mkdir', { target, path });
export const fileCreate = (target, path) => invoke('file_create', { target, path });
export const fileRename = (target, from, to) => invoke('file_rename', { target, from, to });
export const fileDelete = (target, path, recursive = false) => invoke('file_delete', { target, path, recursive });
export const fileReadText = (target, path) => invoke('file_read_text', { target, path });
export const fileWriteText = (target, path, text, expectedSha256) => invoke('file_write_text', { target, path, text, expectedSha256 });
export const pickUpload = () => invoke('plugin:dialog|open', { options: { title: 'Upload file', multiple: false, directory: false } });
export const pickDownload = defaultPath => invoke('plugin:dialog|save', { options: { title: 'Download file', defaultPath } });
export function transferStart(target, direction, localPath, remotePath, operationId, overwrite, onProgress) {
  const Channel = window.__TAURI__?.core?.Channel;
  if (!Channel) return Promise.reject({ kind: 'internal', message: 'Desktop progress channels are unavailable' });
  const channel = new Channel();
  channel.onmessage = onProgress;
  return invoke('transfer_start', { target, direction, localPath, remotePath, operationId, overwrite, channel });
}

export const profilesList = () => invoke('profiles_list');
export const profileSave = profile => invoke('profile_save', { profile });
export const profileRemove = id => invoke('profile_remove', { id });
export const environmentCheck = () => invoke('environment_check');
export const sshConfigSave = server => invoke('ssh_config_save', { server });
export const publicKeyRead = path => invoke('public_key_read', { path });
export const connectionTest = (target, operationId) => invoke('connection_test', { target, operationId });
export const terminalOpenKind = (target, kind, args, cols, rows, channel) => invoke('terminal_open_kind', { target, kind, args, cols, rows, channel });
export const pickConfig = () => invoke('plugin:dialog|open', { options: { title: 'Choose SSH config', multiple: false, directory: false } });
export const pickIdentity = () => invoke('plugin:dialog|open', { options: { title: 'Choose identity file', multiple: false, directory: false } });
export const pickNewIdentity = () => invoke('plugin:dialog|save', { options: { title: 'New identity file' } });
export const accountsRead = target => invoke('accounts_read', { target });
export const accountAction = (target, action, args, password) => invoke('account_action', { target, action, args, password });
