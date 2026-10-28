import * as backend from '../backend.js';
import { state } from '../state.js';
import { esc, head } from '../ui/dom.js';
import { createTerminal } from '../ui/terminal.js';

let current;
const steps = ['Environment', 'Server', 'Trust', 'Public key', 'Connection'];
const field = (id, label, value = '', extra = '') => '<label for="'+id+'">'+label+'</label><input class="field" id="'+id+'" value="'+esc(value)+'" '+extra+'>';
const button = (text, action, primary = false) => '<button type="button" class="pill'+(primary?' primary':'')+'" data-action="'+action+'">'+text+'</button>';
export function render() { return head('Add a server', 'Connect over your system SSH') + '<section class="onboarding"><ol class="setup-steps" aria-label="Setup progress"></ol><article class="card setup-card"><div data-step></div><p data-onboarding-error role="alert"></p></article></section>'; }

function report(s, error) {
  if (current !== s || s.disposed) return;
  s.el.querySelector('[data-onboarding-error]').textContent = (error.kind || 'internal') + ': ' + error.message;
}
function clearError(s) { s.el.querySelector('[data-onboarding-error]').textContent = ''; }
function capture(s) {
  for (const id of ['name','config','alias','hostname','user','port','identity','publicPath']) {
    const input = s.el.querySelector('#setup-'+id); if (input) s[id] = input.value;
  }
}
function cleanupTerminal(s) { if(s.closeTerminal) { s.closeTerminal(); s.generating=false; } s.closeTerminal = null; }
function draw(s) {
  if (current !== s || s.disposed) return;
  cleanupTerminal(s); clearError(s);
  s.el.querySelector('.setup-steps').innerHTML = steps.map((name,i)=>'<li'+(i===s.step?' aria-current="step"':'')+'>'+esc(name)+'</li>').join('');
  const panel = s.el.querySelector('[data-step]');
  if (s.step === 0) {
    const info = s.environment;
    panel.innerHTML = '<h2>Check your environment</h2><p>NodeScape uses OpenSSH on this computer. Keys and passwords stay under your control.</p><div data-environment role="status">'+(info ? '<dl><dt>SSH</dt><dd>'+esc(info.ssh.path)+'<br>'+esc(info.ssh.version || info.ssh.error)+'</dd><dt>Key generation</dt><dd>'+esc(info.sshKeygen.path)+'<br>'+esc(info.sshKeygen.version || info.sshKeygen.error)+'</dd><dt>SSH folder</dt><dd>'+(info.sshDirExists?'Found':'No ~/.ssh folder yet')+'</dd><dt>Public keys</dt><dd>'+esc(info.publicKeys.join(', ') || 'No public key files found')+'</dd></dl>' : 'Checking OpenSSH…')+'</div>'+(state.profileWarning?'<p class="notice">'+esc(state.profileWarning)+'</p>':'')+'<div class="setup-actions">'+button('Check again','check')+'<button class="pill primary" data-action="next" '+(!info || info.ssh.error?'disabled':'')+'>Continue</button></div>';
  } else if (s.step === 1) {
    panel.innerHTML = '<h2>Choose how to connect</h2><p>Use an alias you already have, or create a server in NodeScape’s own SSH config.</p><div class="segtabs" role="group" aria-label="Connection method"><button type="button" data-action="existing" class="'+(s.mode==='existing'?'on':'')+'">Existing SSH config</button><button type="button" data-action="new" class="'+(s.mode==='new'?'on':'')+'">New server</button></div><form data-details><div class="setup-fields"><div>'+field('setup-name','Server name',s.name,'required maxlength="120"')+'</div>'+(s.mode==='existing' ?
      '<div>'+field('setup-config','SSH config file',s.config,'placeholder="Blank uses ~/.ssh/config"')+button('Choose config','config')+'</div><div><label for="setup-alias">SSH alias</label><select class="field" id="setup-alias" required><option value="">Choose an alias</option>'+s.aliases.map(a=>'<option value="'+esc(a)+'" '+(a===s.alias?'selected':'')+'>'+esc(a)+'</option>').join('')+'</select></div>' :
      '<div>'+field('setup-alias','Alias',s.alias,'required placeholder="workshop"')+'</div><div>'+field('setup-hostname','Hostname',s.hostname,'required placeholder="box.example"')+'</div><div>'+field('setup-user','SSH user',s.user,'required autocomplete="off"')+'</div><div>'+field('setup-port','Port',s.port,'required type="number" min="1" max="65535"')+'</div><div class="setup-wide">'+field('setup-identity','Identity file',s.identity,'required placeholder="Absolute path to a private key"')+'<div class="setup-actions">'+button('Choose existing key','identity')+button('New key path','new-path')+button('Generate key','keygen')+'</div><p>To generate a key, choose a new file path. Enter its passphrase only in the terminal below.</p></div>')+'</div><div data-setup-terminal></div><div class="setup-actions">'+button('Back','back')+'<button class="pill primary" type="submit" '+(s.generating?'disabled':'')+'>Continue</button></div></form>';
    panel.querySelector('[data-details]').onsubmit = async event => {
      event.preventDefault(); capture(s); await attempt(s, async () => {
        if (s.mode === 'existing') { if (!s.alias) throw {kind:'invalid_input',message:'Choose an SSH alias'}; s.target = {host:s.alias,config:s.config || null}; }
        else s.target = await backend.sshConfigSave({alias:s.alias,hostname:s.hostname,user:s.user,port:Number(s.port),identityFile:s.identity});
        if (s.disposed) return;
        s.publicPath = s.identity ? s.identity+'.pub' : ''; s.step=2; draw(s); await setupTerminal(s,'trust_host',{});
      });
    };
    panel.querySelector('#setup-config')?.addEventListener('change',()=>{capture(s); loadAliases(s);});
  } else if (s.step === 2) {
    panel.innerHTML = '<h2>Trust the host key</h2><p>Compare OpenSSH’s fingerprint below with a trusted source for your server. Type <code>yes</code> only if it matches, or <code>no</code> to refuse. A changed key must be checked with the server administrator.</p><p>The SSH connection runs only <code>exit</code>. Authentication may fail here before your key is installed; the final test checks access.</p><div data-setup-terminal></div><div class="setup-actions">'+button('Back','back')+button('Show fingerprint again','trust')+button('Continue','next',true)+'</div>';
  } else if (s.step === 3) {
    panel.innerHTML = '<h2>Install a public key (optional)</h2><p>If this server already accepts your key, skip this step. Otherwise choose the matching .pub file and enter the server account password in OpenSSH’s terminal. NodeScape appends the public key only if it is absent.</p><div class="setup-fields"><div class="setup-wide">'+field('setup-publicPath','Public key file',s.publicPath,'placeholder="Absolute path ending in .pub"')+button('Choose public key','public-path')+'</div></div><div class="setup-actions">'+button('Install public key','install')+'</div><div data-setup-terminal></div><div class="setup-actions">'+button('Back','back')+button('Skip key installation','skip')+'<button class="pill primary" data-action="next" '+(!s.installed?'disabled':'')+'>Continue</button></div>';
  } else {
    panel.innerHTML = '<h2>Test your connection</h2><p>Check key authentication with strict host key verification. You can save the server after this succeeds.</p><p><b>'+esc(s.name)+'</b> · '+esc(s.target.host)+'</p><p data-test-status role="status">'+(s.tested?'Connection successful.':'Ready to test.')+'</p><div class="setup-actions">'+button('Back','back')+button('Test connection','test')+'<button class="pill primary" data-action="save" '+(!s.tested?'disabled':'')+'>Save server</button></div>';
  }
  panel.querySelector('[data-details]')?.addEventListener('input', () => capture(s));
  panel.onclick = event => {
    const action=event.target.closest('[data-action]')?.dataset.action; if(!action) return;
    capture(s); attempt(s,()=>act(s,action));
  };
}
async function attempt(s, work) {
  if(s.pending || s.disposed) return;
  s.pending=true; clearError(s);
  const buttons=[...s.el.querySelectorAll('button')].filter(b=>!b.disabled);
  buttons.forEach(b=>b.disabled=true);
  try { await work(); } catch(error) { report(s,error); }
  finally { s.pending=false; buttons.filter(b=>b.isConnected).forEach(b=>b.disabled=false);
    if(!s.disposed) {
      const next=s.el.querySelector('button[type="submit"]'); if(next)next.disabled=!!(s.generating || s.keygenFailed);
      const installed=s.el.querySelector('[data-action="next"]'); if(installed && s.step===3)installed.disabled=!s.installed;
      const save=s.el.querySelector('[data-action="save"]'); if(save)save.disabled=!s.tested;
    } }
}
async function loadAliases(s) {
  const epoch=++s.aliasEpoch, config=s.config;
  try { const aliases=await backend.hosts(config || null); if(s.disposed || epoch!==s.aliasEpoch || s.mode!=='existing' || s.step!==1) return;
    s.aliases=aliases; draw(s);
  } catch(error) { report(s,error); }
}
async function act(s,action) {
  if(action==='check') { s.environment=await backend.environmentCheck(); draw(s); }
  if(action==='next' || action==='skip') { s.step++; s.tested=false; draw(s); if(s.step===1) loadAliases(s); }
  if(action==='back') { s.step--; s.tested=false; s.installed=false; draw(s); if(s.step===1 && s.mode==='existing') loadAliases(s); }
  if(action==='existing' || action==='new') { s.mode=action; draw(s); if(action==='existing') loadAliases(s); }
  if(action==='config') { const path=await backend.pickConfig(); if(path){s.config=path;s.alias=''; await loadAliases(s);} }
  if(action==='identity' || action==='new-path') { const path=await (action==='identity'?backend.pickIdentity():backend.pickNewIdentity()); if(path){s.identity=path;s.keygenFailed=false;draw(s);} }
  if(action==='public-path') { const path=await backend.pickIdentity(); if(path){s.publicPath=path;draw(s);} }
  if(action==='keygen') { s.generating=true; const next=s.el.querySelector('button[type="submit"]'); next.disabled=true;
    await setupTerminal(s,'keygen',{path:s.identity},code=>{s.generating=false;s.keygenFailed=code!==0;next.disabled=code!==0;}); }
  if(action==='trust') await setupTerminal(s,'trust_host',{});
  if(action==='install') {
    const key=await backend.publicKeyRead(s.publicPath); s.installed=false;
    await setupTerminal(s,'install_key',{publicKey:key},code=>{s.installed=code===0; const next=s.el.querySelector('[data-action="next"]'); if(next) next.disabled=!s.installed;});
  }
  if(action==='test') {
    s.tested=false; s.operationId='onboarding-'+crypto.randomUUID();
    s.el.querySelector('[data-test-status]').textContent='Testing…';
    try { await backend.connectionTest(s.target,s.operationId); if(s.disposed)return; s.tested=true; draw(s); }
    finally { s.operationId=null; if(!s.tested && !s.disposed) s.el.querySelector('[data-test-status]').textContent='Connection did not succeed. Check the error and try again.'; }
  }
  if(action==='save' && s.tested) { const profile=await backend.profileSave({id:s.profileId || '',name:s.name,host:s.target.host,config:s.target.config}); if(!s.disposed) await s.context.profilesChanged(profile,true); }
}
async function setupTerminal(s,kind,args,done=()=>{}) {
  cleanupTerminal(s);
  if(kind==='keygen') s.generating=true;
  const holder=s.el.querySelector('[data-setup-terminal]'); holder.className='setup-terminal';
  let id,closed=false,queue=Promise.resolve();
  const term=createTerminal(data=>{ if(!id || closed)return; for(let i=0;i<data.length;) { let end=Math.min(i+8000,data.length); if(end<data.length && /[\uD800-\uDBFF]/.test(data[end-1]))end--; const chunk=data.slice(i,end); i=end; queue=queue.then(()=>!closed && backend.terminalInput(id,chunk)).catch(error=>report(s,error)); } });
  term.attach(holder);
  const fit=()=>{const dimensions=term.fit();if(id && dimensions) backend.terminalResize(id,dimensions.cols,dimensions.rows).catch(error=>report(s,error));};
  const observer=new ResizeObserver(fit); observer.observe(holder);
  s.closeTerminal=()=>{closed=true;observer.disconnect();term.dispose();holder.replaceChildren();holder.className='';if(id)backend.terminalClose(id).catch(()=>{});};
  try {
    const dimensions=term.fit() || {cols:80,rows:18};
    const channel=backend.terminalChannel(event=>{
      if(closed || s.disposed || event.host!==(s.target?.host || 'local-keygen'))return;
      if(event.kind==='output') term.write(new Uint8Array(event.data),()=>{if(!closed)backend.terminalAck(event.id,event.data.length).catch(error=>report(s,error));});
      else if(event.kind==='exit') { done(event.code); if(event.error)report(s,event.error); else if(event.code!==0 && kind!=='trust_host')report(s,{kind:'remote',message:'Setup terminal exited with '+event.code}); }
    });
    const opened=await backend.terminalOpenKind(s.target || {host:'local-keygen',config:null},kind,args,dimensions.cols,dimensions.rows,channel);
    if(closed || s.disposed) {await backend.terminalClose(opened);return;}
    id=opened;term.focus();
  } catch(error) { done(null); throw error; }
}
export function mount(el,context) {
  const s=current={el,context,step:0,mode:'existing',name:'',config:state.defaultConfig || '',alias:'',aliases:[],aliasEpoch:0,hostname:'',user:'',port:'22',identity:'',publicPath:'',environment:null,tested:false,disposed:false,pending:false};
  const profile = state.trustProfile; state.trustProfile = null;
  if (profile) {
    Object.assign(s, { step:2, name:profile.name, alias:profile.host, config:profile.config || '', target:{host:profile.host,config:profile.config}, profileId:profile.id });
    draw(s); attempt(s, () => setupTerminal(s,'trust_host',{}));
  } else { draw(s); attempt(s,async()=>{s.environment=await backend.environmentCheck();draw(s);}); }
}
export function dispose() {
  if(!current)return; const s=current; s.disposed=true; cleanupTerminal(s); if(s.operationId)backend.cancel(s.operationId).catch(()=>{});current=null;
}
