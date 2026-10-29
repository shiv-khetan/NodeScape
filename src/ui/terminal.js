import { Terminal } from '../vendor/xterm/xterm.js';
import { FitAddon } from '../vendor/xterm/addon-fit.js';

export function createTerminal(onData) {
  const element = document.createElement('div');
  element.dataset.terminalScreen = '';
  element.setAttribute('aria-label', 'SSH terminal');
  const tokens = getComputedStyle(document.documentElement);
  const color = name => tokens.getPropertyValue(name).trim();
  const term = new Terminal({
    fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 14,
    cursorBlink: true, screenReaderMode: true, scrollback: 5000,
    theme: { background: color('--terminal-bg'), foreground: color('--on-accent'), cursor: color('--accent-soft'), selectionBackground: color('--accent-text') },
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
