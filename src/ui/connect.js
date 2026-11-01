import * as backend from '../backend.js';
import { esc } from './dom.js';
// Ask for a server login password. Resolves true once the backend holds it, false on Cancel.
// The field is cleared as soon as it is read, and the value is never kept in the page.
export function askLoginPassword({ server, target, refused = false }) {
  document.querySelector('.connect-dialog')?.close();
  return new Promise(resolve => {
    const previous = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'confirm-dialog connect-dialog';
    dialog.setAttribute('aria-labelledby', 'connect-title');
    dialog.innerHTML = '<form autocomplete="off"><h2 id="connect-title">Connect to ' + esc(server) + '</h2>'
      + '<p>' + esc(refused ? 'Check the password and try again.' : server + ' asks for a password.') + '</p>'
      + '<label for="login-password">Password</label><input id="login-password" class="field" type="password" autocomplete="off" spellcheck="false" aria-describedby="login-error" required>'
      + '<p id="login-error" class="error" role="alert">' + (refused ? 'That password was refused.' : '') + '</p>'
      + '<label class="confirm-check"><input type="checkbox" id="login-remember" checked>Remember on this computer (encrypted in Windows Credential Manager)</label>'
      + '<div class="dlg-actions"><button type="button" class="pill" data-cancel>Cancel</button><button type="submit" class="pill primary">Connect</button></div></form>';
    const field = dialog.querySelector('#login-password'), error = dialog.querySelector('#login-error');
    let done = false;
    const finish = value => { if (done) return; done = true; field.value = ''; dialog.close(); dialog.remove(); setTimeout(() => previous?.isConnected && previous.focus()); resolve(value); };
    dialog.querySelector('[data-cancel]').onclick = () => finish(false);
    dialog.oncancel = event => { event.preventDefault(); finish(false); };
    dialog.onclose = () => finish(false);
    dialog.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      let password = field.value; field.value = '';
      const submit = dialog.querySelector('[type=submit]'); submit.disabled = true;
      try { await backend.loginPasswordSet(target, password, dialog.querySelector('#login-remember').checked); password = null; finish(true); }
      catch (failure) { password = null; error.textContent = failure.message || 'Could not use that password.'; submit.disabled = false; field.focus(); }
    };
    document.body.append(dialog); dialog.showModal(); field.focus();
  });
}
