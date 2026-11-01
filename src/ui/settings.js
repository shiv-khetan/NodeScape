import * as backend from '../backend.js';
import { state, store } from '../state.js';
import { $ } from './dom.js';

// Settings dialog: the default SSH config used for new servers.
export function initSettings() {
  const dialog = $('#settings');
  $('#settingsBtn').addEventListener('click', () => {
    $('#sshConfig').value = state.defaultConfig || '';
    dialog.showModal();
  });
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'save') return;
    state.defaultConfig = $('#sshConfig').value.trim().replace(/^"(.*)"$/, '$1') || null;
    store('defaultSshConfig', state.defaultConfig || '');
  });
}

// Once only: turn the pre-profiles single host setting into a saved server.
export async function migrateLegacyHost(reload) {
  if (store('profilesMigrated') === '1') return;
  const host = store('host');
  if (!state.profiles.length && host && host !== 'demo') {
    await backend.profileSave({ id: '', name: host, host, config: store('sshConfig') || null });
    await reload();
  }
  store('profilesMigrated', '1');
}
