import { esc } from './dom.js';
export const hostKeyError = error => /^host_key_/.test(error.kind);
export const canOpenTerminal = error => !['unreachable','timeout'].includes(error.kind) && !hostKeyError(error);
export function errorAdvice(error, host) {
  if (['unreachable','timeout'].includes(error.kind)) return 'Check the network or Tailscale connection to ' + host;
  if (error.kind === 'auth_failed') return 'Check the SSH key or agent for ' + host;
  if (hostKeyError(error)) return "The server's host key isn't trusted yet, or it changed. Compare its fingerprint with a trusted source before approving it. A changed key must be checked with the server administrator.";
  if (error.kind === 'permission_denied') return 'This SSH account does not have permission for this action. Check its access on ' + host + '.';
  if (error.kind?.startsWith('sudo')) return 'This action needs administrator permission. Check the password and sudo access for this SSH account.';
  return '';
}
export function showError(error, el, host) {
  let alert = el.querySelector('.action-alert');
  if (!alert) {
    alert = document.createElement('div');
    alert.className = 'action-alert'; alert.setAttribute('role','alert');
    (el.querySelector('.page-head') || el.firstElementChild)?.after(alert);
  }
  const advice = errorAdvice(error, host);
  alert.innerHTML = '<div><span>' + esc(error.message) + '</span>' + (advice ? '<p>' + esc(advice) + '</p>' : '') + (hostKeyError(error) ? '<button data-approve-host>Approve host key</button>' : '') + '</div><button class="ghost" aria-label="Dismiss error">Dismiss</button>';
  alert.querySelector('[aria-label="Dismiss error"]').onclick = () => alert.remove();
}
