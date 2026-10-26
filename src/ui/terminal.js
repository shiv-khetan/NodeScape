import { Terminal } from '../vendor/xterm/xterm.js';
import { FitAddon } from '../vendor/xterm/addon-fit.js';

export function createTerminal(onData) {
  const element = document.createElement('div');
  element.dataset.terminalScreen = '';
  element.setAttribute('aria-label', 'SSH terminal');
  const term = new Terminal({
    fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 14,
    cursorBlink: true, screenReaderMode: true, scrollback: 5000,
    theme: { background: '#1c1d21', foreground: '#f8f9fb', cursor: '#a9c6ff', selectionBackground: '#2f6bff66' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const data = term.onData(onData);
  let opened = false;
  return {
    element,
    attach(parent) {
      parent.append(element);
      if (!opened) { term.open(element); opened = true; }
    },
    fit() {
      if (!element.isConnected || !element.clientWidth || !element.clientHeight) return null;
      const proposed = fit.proposeDimensions();
      if (!proposed) return null;
      const cols = Math.max(2, Math.min(1000, proposed.cols)), rows = Math.max(2, Math.min(500, proposed.rows));
      term.resize(cols, rows);
      return { cols, rows };
    },
    write: (bytes, done) => term.write(bytes, done),
    focus: () => term.focus(),
    dispose() { data.dispose(); term.dispose(); element.remove(); },
  };
}
