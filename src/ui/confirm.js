import { esc } from './dom.js';
let active;
export function cancelConfirm() { active?.close(); }
export function confirmAction({ verb, object, server, scope, password = 'maybe', explanation = 'This action changes the server.', checks = [] }) {
  cancelConfirm();
  return new Promise(resolve => {
    const focused = document.activeElement, menu = focused?.closest('.row-menu');
    const previous = menu ? document.querySelector('[popovertarget="' + menu.id + '"]') : focused;
    const dialog = document.createElement('dialog');
    active = dialog;
    dialog.className = 'confirm-dialog';
    dialog.setAttribute('aria-labelledby', 'confirm-title');
    dialog.innerHTML = '<form><h2 id="confirm-title">' + esc(verb + ' ' + object) + '?</h2><dl class="confirm-context"><dt>Server</dt><dd>' + esc(server) + '</dd><dt>Scope</dt><dd>' + esc(scope) + '</dd><dt>Requires administrator password</dt><dd>' + esc(password) + '</dd></dl><p>' + esc(explanation) + '</p>' + checks.map(c => '<label class="confirm-check"><input type="checkbox" id="' + esc(c.id) + '"' + (c.required ? ' required' : '') + '>' + esc(c.label) + '</label>').join('') + '<div class="dlg-actions"><button type="button" class="pill" data-cancel autofocus>Cancel</button><button type="submit" class="pill danger">' + esc(verb + ' ' + object) + '</button></div></form>';
    const submit = dialog.querySelector('[type="submit"]');
    const update = () => { submit.disabled = [...dialog.querySelectorAll('input[required]')].some(i => !i.checked); };
    dialog.onchange = update;
    dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
    dialog.querySelector('form').onsubmit = event => { event.preventDefault(); if (!submit.disabled) dialog.close('confirm'); };
    dialog.onclose = () => {
      const result = dialog.returnValue === 'confirm' ? Object.fromEntries(checks.map(c => [c.id, dialog.querySelector('#' + c.id).checked])) : null;
      dialog.remove(); if (active === dialog) active = null;
      if (previous?.isConnected) previous.focus();
      resolve(result);
    };
    document.body.append(dialog); update(); dialog.showModal();
  });
}
