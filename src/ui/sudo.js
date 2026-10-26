function askPassword(wrong) {
  return new Promise((resolve, reject) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'sudo-dialog';
    dialog.setAttribute('aria-labelledby', 'sudo-title');
    dialog.setAttribute('aria-describedby', 'sudo-description');
    dialog.innerHTML = '<form autocomplete="off">'
      + '<h2 id="sudo-title">Administrator permission</h2>'
      + '<p id="sudo-description">This password is used once for this action and never stored.</p>'
      + '<label for="sudo-password">Sudo password</label>'
      + '<input id="sudo-password" class="field" type="password" autocomplete="off" spellcheck="false" autofocus aria-describedby="sudo-description sudo-error">'
      + '<p id="sudo-error" class="sudo-error" role="alert"></p>'
      + '<div class="dlg-actions"><button type="button" class="pill">Cancel</button><button type="submit" class="pill primary">Run action</button></div></form>';
    const form = dialog.querySelector('form'), field = dialog.querySelector('input');
    const cancel = dialog.querySelector('button[type="button"]');
    if (wrong) {
      dialog.querySelector('[role="alert"]').textContent = 'Incorrect password. Try again.';
      field.setAttribute('aria-invalid', 'true');
    }
    function clear() {
      field.value = '';
      form.onsubmit = dialog.oncancel = cancel.onclick = null;
      dialog.close();
      dialog.remove();
    }
    function cancelled() {
      clear();
      reject({ kind: 'cancelled', message: 'Action cancelled' });
    }
    form.onsubmit = event => {
      event.preventDefault();
      let password = field.value;
      clear();
      resolve(password);
      password = null;
    };
    cancel.onclick = cancelled;
    dialog.oncancel = event => { event.preventDefault(); cancelled(); };
    document.body.append(dialog);
    dialog.showModal();
    field.focus();
  });
}

export async function withSudo(run) {
  try {
    return await run(null);
  } catch (error) {
    if (error.kind !== 'sudo_required') throw error;
  }
  let wrong = false;
  for (;;) {
    let password = await askPassword(wrong);
    try {
      const pending = run(password);
      password = null;
      return await pending;
    } catch (error) {
      if (error.kind !== 'sudo_wrong_password') throw error;
      wrong = true;
    } finally {
      password = null;
    }
  }
}
