import { state } from '../state.js';
import { $, isMac, modKey } from './dom.js';
import { openPalette } from './palette.js';
import { healthOf } from './fleet.js';

// Global keys (Cmd on a Mac): Ctrl+K palette, Ctrl+1-9 pages, Ctrl+R/F5 refresh, / search, Up/Down between table rows.
export function initShortcuts({ main, hostInput, go, refresh }) {
  const pages = [...document.querySelectorAll('#nav button')], aria = isMac ? 'Meta+' : 'Control+';
  pages.forEach((button, i) => { button.title += ' (' + modKey + (i + 1) + ')'; button.setAttribute('aria-keyshortcuts', aria + (i + 1)); });
  $('#paletteBtn').title = 'Commands (' + modKey + 'K)';
  $('#paletteBtn').setAttribute('aria-keyshortcuts', aria + 'K');
  const palette = () => openPalette([
    ...pages.filter(b => !b.disabled).map((b, i) => ({ label: 'Go to ' + b.getAttribute('aria-label'), hint: modKey + (i + 1), run: () => go(b.dataset.view) })),
    ...state.profiles.filter(p => p.id !== state.profileId).map(p => ({ label: 'Switch to ' + p.name, hint: healthOf(p.id)?.text, run: () => { hostInput.value = p.id; hostInput.dispatchEvent(new Event('change')); } })),
    { label: 'Refresh', hint: modKey + 'R', run: () => refresh() },
    { label: 'Add server', run: () => go('onboarding') },
    { label: 'Manage servers', run: () => go('servers') },
    { label: 'Settings', run: () => $('#settingsBtn').click() },
  ]);
  $('#paletteBtn').addEventListener('click', palette);
  const typing = el => el.matches('input, textarea, select, [contenteditable], .xterm *');
  document.addEventListener('keydown', e => {
    const ctrl = e.ctrlKey || e.metaKey, open = document.querySelector('dialog[open]');
    if (ctrl && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!open) palette(); return; }
    if ((ctrl && e.key.toLowerCase() === 'r') || e.key === 'F5') { e.preventDefault(); if (!open) refresh(); return; }
    if (open) return;
    if (ctrl && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      const button = pages[e.key - 1];
      if (button && !button.disabled) { e.preventDefault(); go(button.dataset.view); }
      return;
    }
    if (e.key === '/' && !ctrl && !typing(e.target)) {
      const field = main.querySelector('#logsearch') || main.querySelector('.page-toolbar input[type=search], input[type=search]');
      if (field) { e.preventDefault(); field.focus(); }
      return;
    }
    // Up/Down between table rows, staying in the same column of controls.
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !ctrl && !typing(e.target)) {
      const row = e.target.closest?.('tbody tr');
      if (!row || e.target.closest('.row-menu')) return;
      const controls = r => [...r.querySelectorAll('button, a[href], input')].filter(el => el.offsetParent && !el.disabled);
      const column = controls(row).indexOf(e.target);
      let next = row;
      do next = e.key === 'ArrowDown' ? next.nextElementSibling : next.previousElementSibling; while (next && (next.hidden || !controls(next).length));
      if (!next) return;
      e.preventDefault();
      const targets = controls(next);
      (targets[column] || targets[0]).focus();
    }
  });
}
