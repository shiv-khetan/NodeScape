import { esc, head } from './dom.js';
import { askLoginPassword } from './connect.js';
import * as backend from '../backend.js';
export const hostKeyError = error => /^host_key_/.test(error.kind);
export const canOpenTerminal = error => !['unreachable','timeout'].includes(error.kind) && !hostKeyError(error);
export function errorAdvice(error, host) {
  if (['unreachable','timeout'].includes(error.kind)) return 'Check the network or Tailscale connection to ' + host;
  if (error.kind === 'auth_failed') return 'Check the SSH key or agent for ' + host;
  if (error.kind === 'password_required') return host + ' asks for a password. Enter it to connect.';
  if (error.kind === 'password_refused') return 'That password was refused by ' + host + '. Check it and try again.';
  if (error.kind === 'connection_closed') return host + ' closed the connection. It may be limiting connections (for example fail2ban) or sshd may be restarting. Wait a moment, then retry.';
  if (hostKeyError(error)) return "The server’s host key isn’t trusted yet, or it changed. Compare its fingerprint with a trusted source before approving it. A changed key must be checked with the server administrator.";
  if (error.kind === 'permission_denied') return 'This SSH account does not have permission for this action. Check its access on ' + host + '.';
  if (error.kind?.startsWith('sudo')) return 'This action needs administrator permission. Check the password and sudo access for this SSH account.';
  return '';
}
export function showError(error, el, host, { note = '', retry } = {}) {
  let alert = el.querySelector('.action-alert');
  if (!alert) {
    alert = document.createElement('div');
    alert.className = 'action-alert'; alert.setAttribute('role','alert');
    (el.querySelector('.page-head') || el.firstElementChild)?.after(alert);
  }
  const advice = errorAdvice(error, host);
  alert.innerHTML = '<div><span>' + esc(error.message) + '</span>' + (advice ? '<p>' + esc(advice) + '</p>' : '') + (note ? '<p class="muted">' + esc(note) + '</p>' : '') + (hostKeyError(error) ? '<button data-approve-host>Approve host key</button>' : '') + (retry ? '<button data-alert-retry>Retry</button>' : '') + '</div><button class="ghost" aria-label="Dismiss error">Dismiss</button>';
  alert.querySelector('[aria-label="Dismiss error"]').onclick = () => alert.remove();
  if (retry) alert.querySelector('[data-alert-retry]').onclick = retry;
}

export const passwordError = error => ['password_required', 'password_refused'].includes(error?.kind);
// "Show details": run ssh -v once and show the typed reason with the client log.
export async function showDetails(container, target) {
  container.innerHTML = '<p class="muted" role="status">Collecting connection details…</p>';
  try {
    const report = await backend.connectionDiagnose(target);
    // The reason is already on screen; the panel adds the ssh log, and says so if it works now.
    container.innerHTML = (report.ok ? '<p>The connection works now.</p>' : '') + '<pre class="ssh-log" tabindex="0" aria-label="ssh connection log">' + esc(report.log || 'No output from ssh.') + '</pre>';
  } catch (error) {
    container.innerHTML = '<p class="error">' + esc(error.message || String(error)) + '</p>';
  }
}

// The page a server shows when it cannot be reached and nothing from it is on screen yet.
export function renderUnreachable(main, { title, host, server, error, note, target, retry, editServer }) {
  main.innerHTML = head(esc(title), esc(host) + ' · unreachable') + '<section class="grid"><article class="card full unreachable" role="alert"><h2>Can’t reach ' + esc(host) + '</h2><pre class="error">' + esc(error.message) + '</pre>'
    + (note ? '<p class="muted">' + esc(note) + '</p>' : '') + '<p>' + esc(errorAdvice(error, host) || 'Check that ssh ' + host + ' works in a terminal without a password prompt.') + '</p><div class="dlg-actions">'
    + (passwordError(error) ? '<button class="primary" data-login>Enter password</button>' : '<button class="primary" data-retry>Retry</button>') + '<button data-edit-server>Edit server</button><button data-diagnose>Show details</button>'
    + (hostKeyError(error) ? '<button data-approve-host>Approve host key</button>' : '') + (canOpenTerminal(error) ? '<button data-go="terminal">Open terminal</button>' : '') + '</div><div data-diagnosis></div></article></section>';
  main.querySelector('[data-retry]')?.addEventListener('click', retry);
  main.querySelector('[data-login]')?.addEventListener('click', async () => { if (await askLoginPassword({ server, target })) retry(); });
  main.querySelector('[data-diagnose]').onclick = () => showDetails(main.querySelector('[data-diagnosis]'), target);
  main.querySelector('[data-edit-server]').onclick = editServer;
}
// Keep what a page last showed, dimmed and inert, under the error band.
export function markStale(main) {
  main.querySelectorAll('.page-head ~ *').forEach(node => { node.inert = true; node.classList.add('stale'); });
  const meta = main.querySelector('.page-meta');
  if (meta && !/unreachable/.test(meta.textContent)) meta.append(' · unreachable');
}
