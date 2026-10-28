import { runAction } from './confirm.js';
import { state } from '../state.js';
export async function withSudo(run, label = 'Run action') {
  const result = await runAction({ verb: label, object: '', server: state.profiles.find(p => p.id === state.profileId)?.name || state.host, scope: 'system', confirm: false, run });
  if (!result) throw { kind: 'cancelled', message: 'Action cancelled' };
  return result;
}
