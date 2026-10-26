import * as backend from '../backend.js';
import { currentTarget, requestContext, isCurrent } from '../state.js';
import { esc, head } from '../ui/dom.js';

const icons = {
  dir: '<svg viewBox="0 0 24 24"><path d="M3 7h7l2 2h9v11H3zM3 7V4h7l2 3"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M5 3h9l5 5v13H5zM14 3v6h5M8 13h8M8 17h6"/></svg>',
  symlink: '<svg viewBox="0 0 24 24"><path d="m10 8 3-3a4 4 0 0 1 6 6l-3 3M14 16l-3 3a4 4 0 0 1-6-6l3-3M8 16l8-8"/></svg>',
  other: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v5M12 16h.01"/></svg>',
};
const size = n => n == null ? 'Unavailable' : n < 1024 ? n + ' B' : n < 1024 ** 2 ? (n / 1024).toFixed(1) + ' KiB' : (n / 1024 ** 2).toFixed(1) + ' MiB';
const modified = n => n == null ? 'Unavailable' : new Date(n * 1000).toLocaleString();
const join = (path, name) => path.replace(/\/+$/, '') + '/' + name;
let view, events;

export function load(target) {
  if (!view || JSON.stringify(view.target) !== JSON.stringify(target)) {
    view = { target: { ...target }, path: '/', entries: [], transfers: [], editor: null };
  }
  return view;
}

export function render() {
  return head('Files', esc(currentTarget().host)) + '<section class="files grid">' +
    '<article class="card full files-browser">' +
      '<form id="files-location" class="files-location"><label for="files-path">Remote path</label>' +
      '<input class="field mono" id="files-path" spellcheck="false" autocomplete="off" value="' + esc(view.path) + '">' +
      '<button class="pill" type="submit">Go</button></form>' +
      '<nav id="files-crumbs" class="files-crumbs" aria-label="Directory breadcrumbs"></nav>' +
      '<div class="files-tools"><button class="pill" data-file-action="mkdir">New folder</button><button class="pill" data-file-action="create">New file</button>' +
      '<button class="pill primary" data-file-action="upload">Upload</button><button class="pill" data-file-action="refresh">Refresh files</button></div>' +
      '<p id="files-error" class="error" role="alert" hidden></p><button class="pill" id="files-recursive" hidden>Delete recursively</button>' +
      '<div class="files-table-head"><span>Name</span><span>Size</span><span>Modified</span><span></span></div>' +
      '<div id="files-entries" aria-live="polite"><p>Loading directory…</p></div></article>' +
    '<article class="card full" id="files-editor" hidden></article>' +
    '<article class="card full files-transfers" id="files-transfers" hidden><h2>Transfers</h2><div id="files-transfer-list"></div></article>' +
    '<dialog id="files-name-dialog"><form id="files-name-form"><h2 id="files-name-title"></h2><label for="files-name">Name</label>' +
      '<input class="field" id="files-name" required maxlength="255" autocomplete="off"><p id="files-name-error" class="error" role="alert" hidden></p>' +
      '<div class="dlg-actions"><button class="pill" type="button" data-file-action="dismiss">Cancel</button><button class="pill primary" type="submit">Apply</button></div></form></dialog></section>';
}

export function mount(el) {
  events = new AbortController();
  const signal = events.signal, model = view, context = requestContext();
  const valid = () => !signal.aborted && isCurrent(context);
  const $ = selector => el.querySelector(selector);
  let listSequence = 0, editorSequence = 0, nameAction, recursiveCandidate;
  const error = err => {
    if (!valid()) return;
    $('#files-error').textContent = err?.message || String(err);
    $('#files-error').hidden = false;
  };
  function drawCrumbs() {
    const parts = model.path.split('/').filter(Boolean);
    $('#files-crumbs').innerHTML = '<button class="pill" data-path="/" aria-label="Root directory">/</button>' +
      parts.map((part, i) => '<span aria-hidden="true">/</span><button class="pill" data-path="' + esc('/' + parts.slice(0, i + 1).join('/')) + '">' + esc(part) + '</button>').join('');
  }
  function drawEntries() {
    $('#files-entries').innerHTML = model.entries.length ? model.entries.map((entry, index) => {
      const action = (name, title = name) => '<button data-file-action="' + name.toLowerCase() + '" data-index="' + index + '" aria-label="' + title + '">' + name + '</button>';
      return '<div class="files-row"><div class="who"><span class="ic file-icon" aria-label="' + esc(entry.kind) + '">' + (icons[entry.kind] || icons.other) + '</span><div class="file-label"><p class="file-name">' + esc(entry.name) + '</p>' +
        (entry.kind === 'symlink' ? '<small>Symlink' + (entry.linkTarget != null ? ' → ' + esc(entry.linkTarget) : '') + '</small>' : '') +
        '</div></div><span class="file-size">' + size(entry.size) + '</span><time class="file-modified">' + esc(modified(entry.mtime)) + '</time><div class="acts file-actions">' +
        (entry.kind === 'dir' ? action('Open', 'Open folder') : entry.kind === 'file' ? action('Edit') + action('Download') : '') +
        action('Rename') + action('Delete') + '</div></div>';
    }).join('') : '<p class="files-empty">This directory is empty. Create a file or upload one to get started.</p>';
  }
  async function list(path = model.path) {
    if (!valid()) return;
    const sequence = ++listSequence;
    $('#files-error').hidden = true; $('#files-recursive').hidden = true; recursiveCandidate = null;
    $('#files-entries').setAttribute('aria-busy', 'true');
    try {
      if (!path.startsWith('/') || /[\0\r\n]/.test(path) || path.split('/').some(p => p === '.' || p === '..')) throw { message: 'Use an absolute remote path without dot segments.' };
      const entries = await backend.filesList(model.target, path);
      if (!valid() || sequence !== listSequence) return;
      model.path = path.replace(/\/+$/, '') || '/'; model.entries = entries;
      $('#files-path').value = model.path;
      drawCrumbs(); drawEntries();
    } catch (err) {
      if (valid() && sequence === listSequence) error(err);
    } finally {
      if (valid() && sequence === listSequence) $('#files-entries').removeAttribute('aria-busy');
    }
  }
  function drawEditor() {
    const editor = model.editor, panel = $('#files-editor');
    panel.hidden = !editor;
    if (!editor) { panel.innerHTML = ''; return; }
    panel.innerHTML = '<div class="card-top"><h2>' + esc(editor.path) + '</h2><span class="tag">UTF-8 · up to 1 MiB</span></div>' +
      '<label for="files-text">File text</label><textarea id="files-text" spellcheck="false">' + esc(editor.text) + '</textarea>' +
      '<p id="files-editor-error" class="error" role="alert" hidden></p><div class="dlg-actions"><button class="pill" data-file-action="cancel-edit" aria-label="Cancel editing">Cancel</button><button class="pill primary" data-file-action="save">Save</button></div>';
  }
  model.drawTransfers = () => {
    if (!valid()) return;
    $('#files-transfers').hidden = !model.transfers.length;
    $('#files-transfer-list').innerHTML = model.transfers.map(item => {
      const percent = item.total ? Math.min(100, Math.floor(item.bytes / item.total * 100)) : 0;
      return '<div class="file-transfer"><div class="file-transfer-top"><b>' + esc(item.name) + '</b><span>' + esc(item.status) + '</span>' +
        (!item.done ? '<button class="pill" data-cancel-transfer="' + esc(item.id) + '" aria-label="Cancel transfer">Cancel</button>' : '') + '</div>' +
        '<div class="track" role="progressbar" aria-label="' + esc(item.name) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + percent + '"><i class="blue" style="width:' + percent + '%"></i></div>' +
        '<small>' + size(item.bytes) + ' / ' + size(item.total) + '</small></div>';
    }).join('');
  };
  async function startTransfer(direction, entry) {
    const directory = model.path;
    try {
      const local = direction === 'up' ? await backend.pickUpload() : await backend.pickDownload(entry.name);
      if (!local || !valid()) return;
      const name = direction === 'up' ? local.split(/[\\/]/).pop() : entry.name;
      const remote = join(directory, name);
      const overwrite = direction === 'down' || model.entries.some(e => e.name === name);
      if (direction === 'up' && overwrite && !confirm('Replace ' + name + ' on ' + model.target.host + '?')) return;
      const item = { id: crypto.randomUUID(), name, bytes: 0, total: null, status: direction === 'up' ? 'Uploading' : 'Downloading' };
      model.transfers.push(item); model.drawTransfers();
      try {
        await backend.transferStart(model.target, direction, local, remote, item.id, overwrite, progress => {
          item.bytes = Math.max(0, Number(progress.bytes) || 0); item.total = Math.max(0, Number(progress.total) || 0);
          if (item.cancelRequested) backend.cancel(item.id).catch(() => {});
          model.drawTransfers();
        });
        item.status = 'Complete';
        if (direction === 'up' && valid()) await list();
      } catch (err) { item.status = err.kind === 'cancelled' ? 'Cancelled' : err.message; }
      item.done = true; model.drawTransfers();
    } catch (err) { error(err); }
  }
  async function remove(candidate, recursive) {
    if (!confirm(recursive ? 'Delete ' + candidate.name + ' and ALL its contents recursively? This cannot be undone.' : 'Delete ' + candidate.name + '?')) return;
    try {
      await backend.fileDelete(model.target, candidate.path, recursive);
      if (valid()) await list();
    } catch (err) {
      error(err);
      if (valid() && candidate.kind === 'dir' && !recursive && err.kind === 'remote') {
        recursiveCandidate = candidate; $('#files-recursive').hidden = false;
      }
    }
  }
  el.addEventListener('submit', async event => {
    if (event.target.id === 'files-location') { event.preventDefault(); await list($('#files-path').value.trim()); }
    if (event.target.id !== 'files-name-form') return;
    event.preventDefault();
    const name = $('#files-name').value;
    if (!name || /[/\0\r\n]/.test(name) || name === '.' || name === '..') {
      $('#files-name-error').textContent = 'Enter a single name without slashes or control characters.'; $('#files-name-error').hidden = false; return;
    }
    const pending = nameAction;
    $('#files-name-dialog').close();
    try {
      const path = join(pending.directory, name);
      if (pending.action === 'mkdir') await backend.fileMkdir(model.target, path);
      if (pending.action === 'create') await backend.fileCreate(model.target, path);
      if (pending.action === 'rename') await backend.fileRename(model.target, pending.from, path);
      if (valid()) await list();
    } catch (err) { error(err); }
  }, { signal });
  el.addEventListener('input', event => {
    if (event.target.id === 'files-text' && model.editor) model.editor.text = event.target.value;
  }, { signal });
  el.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.path) { await list(button.dataset.path); return; }
    if (button.id === 'files-recursive' && recursiveCandidate) { await remove(recursiveCandidate, true); return; }
    if (button.dataset.cancelTransfer) {
      const item = model.transfers.find(t => t.id === button.dataset.cancelTransfer);
      item.cancelRequested = true; item.status = 'Cancelling…'; model.drawTransfers();
      try { await backend.cancel(item.id); } catch (err) { error(err); }
      return;
    }
    const action = button.dataset.fileAction, entry = model.entries[Number(button.dataset.index)];
    if (action === 'dismiss') { $('#files-name-dialog').close(); return; }
    if (['mkdir', 'create', 'rename'].includes(action)) {
      nameAction = { action, directory: model.path, from: entry && join(model.path, entry.name) };
      $('#files-name-title').textContent = { mkdir: 'New folder', create: 'New file', rename: 'Rename' }[action];
      $('#files-name').value = action === 'rename' ? entry.name : ''; $('#files-name-error').hidden = true;
      $('#files-name-dialog').showModal(); $('#files-name').select(); return;
    }
    if (action === 'refresh') await list();
    if (action === 'open') await list(join(model.path, entry.name));
    if (action === 'upload' || action === 'download') await startTransfer(action === 'upload' ? 'up' : 'down', entry);
    if (action === 'delete') await remove({ ...entry, path: join(model.path, entry.name) }, false);
    if (action === 'edit') {
      const sequence = ++editorSequence, path = join(model.path, entry.name);
      try {
        const text = await backend.fileReadText(model.target, path);
        if (!valid() || sequence !== editorSequence) return;
        model.editor = { path, ...text }; drawEditor(); $('#files-text').focus();
      } catch (err) { error(err); }
    }
    if (action === 'cancel-edit') { editorSequence++; model.editor = null; drawEditor(); }
    if (action === 'save' && model.editor) {
      const editor = model.editor;
      button.disabled = true;
      try {
        await backend.fileWriteText(model.target, editor.path, editor.text, editor.mtime);
        if (valid() && editor === model.editor) { model.editor = null; drawEditor(); await list(); }
      } catch (err) {
        if (valid() && editor === model.editor) {
          $('#files-editor-error').textContent = err.message; $('#files-editor-error').hidden = false;
          $('#files-editor-error').classList.toggle('files-conflict', err.kind === 'conflict');
        }
      } finally { if (valid()) button.disabled = false; }
    }
  }, { signal });
  drawCrumbs(); drawEditor(); model.drawTransfers(); list();
}
export function dispose() { events?.abort(); }
