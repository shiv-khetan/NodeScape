import * as backend from '../backend.js';
// What admin (sudo) actions will need on this server, checked once per server per session.
const pending = new Map(), known = new Map();
const key = target => target.host + '\0' + (target.config || '');

export const ADMIN_NOTE = {
  password: 'Admin actions ask for your sudo password',
  passwordless: 'Admin actions run with passwordless sudo',
  none: 'This account isn’t in a sudo group, so admin actions will likely be refused',
  missing: 'sudo isn’t installed on this server, so admin actions are unavailable',
};
const ROW = { password: 'Yes', passwordless: 'No, passwordless sudo', none: 'Not available for this account', missing: 'Not available for this account' };

export function adminStatus(target) {
  const k = key(target);
  if (!pending.has(k)) pending.set(k, backend.sudoStatus(target).then(status => { known.set(k, status); return status; }, () => 'unknown'));
  return pending.get(k);
}
/** The confirm dialog's "Requires administrator password" value, once the status is known. */
export const adminRow = target => ROW[known.get(key(target))] || 'Yes, if sudo asks for it';
/** Fill every .admin-note in el when the status arrives; leave it empty if it cannot be checked. */
export async function fillAdminNote(el, target) {
  const status = await adminStatus(target);
  for (const note of el.querySelectorAll('.admin-note')) note.textContent = ADMIN_NOTE[status] || '';
}
