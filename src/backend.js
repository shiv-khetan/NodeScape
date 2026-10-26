/** @typedef {{host: string, config: string|null}} Target */
/** @typedef {{kind: string, message: string}} BackendError */

export const available = () => typeof window.__TAURI__?.core?.invoke === 'function';

async function invoke(command, args = {}) {
  try {
    if (!available()) throw { kind: 'internal', message: 'NodeScape needs its desktop app to run' };
    return await window.__TAURI__.core.invoke(command, args);
  } catch (error) {
    throw {
      kind: typeof error?.kind === 'string' ? error.kind : 'internal',
      message: String(error?.message ?? error).slice(0, 4000),
    };
  }
}

/** @param {Target} target @param {'snapshot'|'processes'|'timers'} what @returns {Promise<string>} */
export const query = (target, what) => invoke('query', { ...target, what });
/** @param {Target} target @param {string|null} unit @param {number} lines @returns {Promise<string>} */
export const logs = (target, unit = null, lines = 300) => invoke('logs', { ...target, unit, lines });
/** @param {Target} target @param {string} unit @param {'start'|'stop'|'restart'} action @returns {Promise<string>} */
export const serviceAction = (target, unit, action) => invoke('service_action', { ...target, unit, action });
/** @param {string|null} config @returns {Promise<string[]>} */
export const hosts = (config = null) => invoke('hosts', { config });
/** @param {string} id @returns {Promise<void>} */
export const cancel = id => invoke('operation_cancel', { id });
