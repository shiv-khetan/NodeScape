import { esc } from './dom.js';
// Command palette: commands are {label, hint?, run}. Built fresh on each open so it reflects current servers.
export function openPalette(commands) {
  if (document.querySelector('.palette[open]')) return;
  // A just-closed palette lingers until its close event runs; a quick reopen replaces it.
  document.querySelector('.palette')?.remove();
  const previous = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'palette';
  dialog.setAttribute('aria-label', 'Commands');
  dialog.innerHTML = '<input class="field" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" aria-label="Type a command" placeholder="Type a command or page…" autocomplete="off" spellcheck="false"><ul id="palette-list" role="listbox" aria-label="Commands"></ul>';
  const input = dialog.querySelector('input'), list = dialog.querySelector('ul');
  let shown = [], active = 0;
  const render = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = commands.filter(c => words.every(w => c.label.toLowerCase().includes(w)));
    active = Math.min(active, Math.max(shown.length - 1, 0));
    list.innerHTML = shown.length ? shown.map((c, i) => '<li role="option" id="palette-' + i + '" aria-selected="' + (i === active) + '">' + esc(c.label) + (c.hint ? '<kbd>' + esc(c.hint) + '</kbd>' : '') + '</li>').join('') : '<li class="muted">No matching commands</li>';
    if (shown.length) { input.setAttribute('aria-activedescendant', 'palette-' + active); list.children[active].scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  };
  const runAt = i => { const command = shown[i]; if (!command) return; dialog.close(); command.run(); };
  input.oninput = () => { active = 0; render(); };
  input.onkeydown = e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) { active = (active + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length; render(); } }
    else if (e.key === 'Enter') { e.preventDefault(); runAt(active); }
  };
  list.onclick = e => { const option = e.target.closest('[role=option]'); if (option) runAt([...list.children].indexOf(option)); };
  dialog.onclick = e => { if (e.target === dialog) dialog.close(); };
  dialog.onclose = () => { dialog.remove(); if (previous?.isConnected && !document.querySelector('dialog[open]') && document.activeElement === document.body) previous.focus(); };
  document.body.append(dialog); render(); dialog.showModal(); input.focus();
}
