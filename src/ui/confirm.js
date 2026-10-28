import { esc } from './dom.js';
let active;
export function cancelConfirm() { active?.close(); }
export function confirmAction({ verb, object, server, scope, password = 'Yes, if sudo asks for it', explanation = 'This action changes the server.', checks = [], run, allowSudo = true, passwordMode = false, destructive = true }) {
  cancelConfirm();
  return new Promise((resolve, reject) => {
    const focused = document.activeElement, menu = focused?.closest('.row-menu');
    const previous = menu ? document.querySelector('[popovertarget="' + menu.id + '"]') : focused;
    const dialog = document.createElement('dialog');
    let finished = false, sending = false, expanded = passwordMode;
    active = dialog;
    dialog.className = 'confirm-dialog';
    dialog.setAttribute('aria-labelledby', 'confirm-title');
    const label = [verb, object].filter(Boolean).join(' ');
    dialog.innerHTML = '<form autocomplete="off"><h2 id="confirm-title">' + esc(label) + (passwordMode ? '' : '?') + '</h2><dl class="confirm-context"><dt>Server</dt><dd>' + esc(server) + '</dd><dt>Scope</dt><dd>' + esc(scope) + '</dd><dt>Requires administrator password</dt><dd>' + esc(password) + '</dd></dl><p>' + esc(explanation) + '</p>' + checks.map(c => '<label class="confirm-check"><input type="checkbox" id="' + esc(c.id) + '"' + (c.required ? ' required' : '') + '>' + esc(c.label) + '</label>').join('') + '<div data-password hidden><label for="sudo-password">Administrator password for ' + esc(server) + '</label><p id="sudo-description">This password is used once for this action and never stored.</p><input id="sudo-password" class="field" type="password" autocomplete="off" spellcheck="false" aria-describedby="sudo-description sudo-error"><p id="sudo-error" class="error" role="alert"></p></div><div class="dlg-actions"><button type="button" class="pill" data-cancel autofocus>Cancel</button><button type="submit" class="pill ' + (destructive ? 'danger' : 'primary') + '">' + esc(label) + '</button></div></form>';
    const submit = dialog.querySelector('[type="submit"]'), field = dialog.querySelector('[type="password"]');
    const values = () => Object.fromEntries(checks.map(c => [c.id, dialog.querySelector('#' + c.id).checked]));
    const update = () => { submit.disabled = sending || checks.some(c => c.required && !dialog.querySelector('#' + c.id).checked); };
    const expand = wrong => {
      expanded = true;
      dialog.querySelector('[data-password]').hidden = false;
      dialog.querySelector('#sudo-error').textContent = wrong ? 'Incorrect password. Try again.' : '';
      field.setAttribute('aria-invalid', String(wrong));
      field.focus();
    };
    dialog.onchange = update;
    dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
    dialog.oncancel = event => { event.preventDefault(); dialog.close(); };
    dialog.querySelector('form').onsubmit = async event => {
      event.preventDefault(); if (submit.disabled || finished) return;
      if (!run) { dialog.close('confirm'); return; }
      sending = true; update();
      let secret = expanded ? field.value : null;
      field.value = '';
      try {
        const pending = run(secret, values());
        secret = null;
        await pending;
        if (!finished) dialog.close('confirm');
      } catch (error) {
        if (finished) return;
        if (allowSudo && ['sudo_required','sudo_wrong_password'].includes(error.kind)) expand(error.kind === 'sudo_wrong_password');
        else { finished = true; dialog.close(); reject(error); }
      } finally { secret = null; sending = false; update(); }
    };
    dialog.onclose = () => {
      field.value = '';
      const result = dialog.returnValue === 'confirm' ? values() : null;
      dialog.remove(); if (active === dialog) active = null;
      if (!finished) { finished = true; resolve(result); }
      // Callers disable their buttons while an action is pending and re-enable them once this
      // promise settles; return focus after that, since a disabled trigger cannot take focus.
      setTimeout(() => { if (previous?.isConnected) previous.focus(); });
    };
    document.body.append(dialog); update(); dialog.showModal();
    if (passwordMode) expand(false);
  });
}
export async function runAction(options) {
  if (options.confirm !== false) return confirmAction(options);
  try { await options.run(null); return {}; }
  catch (error) {
    if (error.kind !== 'sudo_required' || options.allowSudo === false) throw error;
    return confirmAction({ ...options, passwordMode: true });
  }
}
