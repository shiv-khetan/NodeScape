import { esc } from './dom.js';
let next = 0;
export function rowMenu(label, items) {
  const id = 'row-menu-' + ++next;
  return '<button class="icon-button" popovertarget="' + id + '" aria-label="More actions for ' + esc(label) + '" title="More actions">⋯</button><div id="' + id + '" class="row-menu" popover>' + items + '</div>';
}
export function initMenus() {
  document.addEventListener('beforetoggle', event => {
    const menu = event.target;
    if (!menu.matches?.('.row-menu') || event.newState !== 'open') return;
    const button = document.querySelector('[popovertarget="' + menu.id + '"]');
    const r = button.getBoundingClientRect(), height = menu.children.length * 32 + 10;
    menu.style.left = Math.max(8, Math.min(innerWidth - 208, r.right - 200)) + 'px';
    menu.style.top = Math.max(8, Math.min(innerHeight - height - 8, r.bottom + 4)) + 'px';
  }, true);
  document.addEventListener('click', event => {
    const item = event.target.closest('.row-menu button');
    if (item) item.closest('.row-menu').hidePopover();
  });
  window.addEventListener('resize', () => document.querySelectorAll('.row-menu:popover-open').forEach(m => m.hidePopover()));
}
