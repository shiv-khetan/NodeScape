import * as backend from '../backend.js';
import { currentTarget } from '../state.js';
import { esc, head } from '../ui/dom.js';
import { createTerminal } from '../ui/terminal.js';

let session, mounted, observer, events, frame;
const key = target => JSON.stringify(target);
function update() {
  if (!mounted || !session) return;
  const status = mounted.querySelector('[data-terminal-status]');
  status.textContent = session.status;
  status.className = 'tag status' + (session.status === 'Connected' ? ' ok' : session.error ? ' bad' : '');
  mounted.querySelector('[data-terminal-error]').textContent = session.error;
  mounted.querySelector('[data-terminal-connect]').textContent = session.attempted ? 'Reconnect' : 'Connect';
  mounted.querySelector('[data-terminal-connect]').disabled = session.status === 'Connecting…';
  mounted.querySelector('[data-terminal-disconnect]').disabled = !session.id && !session.opening;
}
function fail(s, error) {
  if (session !== s || s.disposed) return;
  s.error = error.message;
  s.status = 'Error';
  update();
}
async function disconnect(s) {
  s.epoch++;
  const id = s.id;
  s.id = null;
  s.status = 'Disconnected';
  update();
  if (id) await backend.terminalClose(id);
}
function fit() {
  if (!session || !mounted) return;
  const card = mounted.querySelector('.terminal-card');
  card.style.height = Math.max(280, innerHeight - card.getBoundingClientRect().top - parseFloat(getComputedStyle(document.body).paddingBottom)) + 'px';
  const s = session, dimensions = s.terminal.fit();
  if (!dimensions) return;
  if (s.id && (dimensions.cols !== s.cols || dimensions.rows !== s.rows)) {
    s.cols = dimensions.cols; s.rows = dimensions.rows;
    const id = s.id, { cols, rows } = dimensions;
    s.queue = s.queue.then(() => id === s.id && backend.terminalResize(id, cols, rows)).catch(error => fail(s, error));
  }
}
function scheduleFit() { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); }
async function connect(s) {
  if (s.opening || s.disposed) return;
  try {
    await disconnect(s);
    if (s.disposed || session !== s) return;
    const epoch = ++s.epoch;
    s.attempted = true; s.error = ''; s.status = 'Connecting…'; s.opening = true;
    update();
    const dimensions = s.terminal.fit() || { cols: 80, rows: 24 };
    s.cols = dimensions.cols; s.rows = dimensions.rows;
    let exited = false;
    const channel = backend.terminalChannel(event => {
      if (s.disposed || epoch !== s.epoch || event.host !== s.target.host) return;
      if (event.kind === 'output') {
        const bytes = new Uint8Array(event.data);
        s.terminal.write(bytes, () => {
          if (!s.disposed && epoch === s.epoch) backend.terminalAck(event.id, bytes.byteLength).catch(error => fail(s, error));
        });
      } else if (event.kind === 'exit') {
        exited = true;
        // Queue the status after the final xterm write as well.
        s.terminal.write(new Uint8Array(), () => {
          if (s.disposed || epoch !== s.epoch) return;
          s.status = event.error ? 'Error' : 'Exited (' + (event.code ?? '?') + ')';
          s.error = event.error?.message || '';
          update();
        });
      }
    });
    s.channel = channel;
    const id = await backend.terminalOpen(s.target, s.cols, s.rows, channel);
    if (s.disposed || epoch !== s.epoch) { await backend.terminalClose(id); return; }
    s.id = id;
    if (!exited) s.status = 'Connected';
    if (mounted) { fit(); s.terminal.focus(); }
  } catch (error) { fail(s, error); }
  finally { s.opening = false; update(); }
}
function create(target) {
  const s = { target, id: null, status: 'Disconnected', error: '', epoch: 0, queue: Promise.resolve(), attempted: false, disposed: false };
  s.terminal = createTerminal(data => {
    const id = s.id;
    if (!id || s.status !== 'Connected') return;
    // Keep keystrokes ordered and paste chunks below the backend byte limit.
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(offset + 8000, data.length);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
      const chunk = data.slice(offset, end); offset = end;
      s.queue = s.queue.then(() => !s.disposed && id === s.id && backend.terminalInput(id, chunk)).catch(error => fail(s, error));
    }
  });
  return s;
}
export function targetChanged() {
  if (!session || key(session.target) === key(currentTarget())) return;
  const s = session;
  session = null;
  s.disposed = true;
  disconnect(s).catch(() => {});
  s.terminal.dispose();
  return true;
}
export function render() {
  return head('Terminal', esc(currentTarget().host)) + '<article class="card terminal-card"><div class="terminal-toolbar"><span class="tag status" data-terminal-status role="status">Disconnected</span><div class="acts"><button data-terminal-connect>Connect</button><button data-terminal-disconnect disabled>Disconnect</button></div></div><p class="terminal-error" data-terminal-error role="alert"></p><div class="terminal-holder"></div></article>';
}
export function mount(el) {
  mounted = el;
  targetChanged();
  if (!session) session = create(currentTarget());
  session.terminal.attach(el.querySelector('.terminal-holder'));
  events = new AbortController();
  el.querySelector('[data-terminal-connect]').addEventListener('click', () => connect(session), { signal: events.signal });
  el.querySelector('[data-terminal-disconnect]').addEventListener('click', () => disconnect(session).catch(error => fail(session, error)), { signal: events.signal });
  observer = new ResizeObserver(scheduleFit);
  observer.observe(el.querySelector('.terminal-holder'));
  window.addEventListener('resize', scheduleFit, { signal: events.signal });
  update(); scheduleFit();
  if (!session.attempted) connect(session);
}
export function dispose() {
  observer?.disconnect(); events?.abort(); cancelAnimationFrame(frame); mounted = null;
}
window.addEventListener('beforeunload', () => { if (session?.id) backend.terminalClose(session.id).catch(() => {}); });
