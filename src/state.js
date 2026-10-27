export const store = (key, value) => {
  try { return value === undefined ? localStorage.getItem(key) : localStorage.setItem(key, value); }
  catch { return null; }
};


export const state = {
  host: '', config: null, profileId: '', profiles: [], profileWarning: '',
  defaultConfig: (store('defaultSshConfig') ?? store('sshConfig')) || null,
  view: 'overview', live: true, busy: false, generation: 0,
  snap: null, histories: new Map(),
  svcFilter: '', svcState: 'all', logUnit: '', logLines: 300,
};
export const currentTarget = () => ({ host: state.host, config: state.config });
const key = target => JSON.stringify(target);
export const history = (target = currentTarget()) => state.histories.get(key(target)) || { cpu: [], rx: [], tx: [] };
export const requestContext = () => ({ generation: state.generation, target: currentTarget(), view: state.view });
export const isCurrent = request => request.generation === state.generation && request.view === state.view && key(request.target) === key(currentTarget());
export function beginRequest() {
  state.generation++;
  return requestContext();
}
export function selectTarget(host, config = state.config) {
  state.generation++;
  state.host = host;
  state.config = config;
  state.snap = null;
  state.svcFilter = ''; state.svcState = 'all'; state.logUnit = ''; state.logLines = 300;
}
export function acceptSnapshot(request, snapshot) {
  if (!isCurrent(request)) return;
  const previous = history(request.target);
  state.histories.set(key(request.target), {
    cpu: [...previous.cpu, snapshot.cpu].slice(-48),
    rx: [...previous.rx, snapshot.rx].slice(-14),
    tx: [...previous.tx, snapshot.tx].slice(-14),
  });
  state.snap = snapshot;
}

export function selectProfile(profile) {
  state.profileId = profile?.id || '';
  selectTarget(profile?.host || '', profile?.config || null);
  store('selectedProfile', state.profileId);
}
