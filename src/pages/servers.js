import * as backend from '../backend.js';
import { state } from '../state.js';
import { confirmAction } from '../ui/confirm.js';
import { esc, head, search, segTabs, plural, secretStore } from '../ui/dom.js';
import { statusCell } from '../ui/fleet.js';
let active;
export function render() {
  return head('Manage servers', plural(state.profiles.length,'saved server'), search('servers-filter','Search servers'), '', '<button class="pill primary" data-go="onboarding">Add server</button>') + '<section class="grid"><article class="card servers-card full">'+(state.profileWarning?'<p class="notice">'+esc(state.profileWarning)+'</p>':'')+'<div class="card-top"><div><h2>Saved servers</h2><span class="muted">Connection details only. Remembered passwords are encrypted in '+secretStore+'; private keys are never stored.</span></div></div><div data-server-editor></div><p data-server-error role="alert"></p><table aria-label="Saved servers"><thead><tr><th>Name</th><th>Status</th><th>Target</th><th>Config</th><th>Actions</th></tr></thead><tbody>'+state.profiles.map(p=>'<tr data-server-row><td><div class="who"><p>'+esc(p.name)+'</p></div></td><td class="server-status">'+statusCell(p.id)+'</td><td class="mono">'+esc(p.host)+'</td><td>'+esc(p.config || 'Default OpenSSH config')+'</td><td><div class="acts"><button data-edit="'+esc(p.id)+'">Edit</button><button class="destructive" data-remove="'+esc(p.id)+'">Remove</button></div></td></tr>').join('')+'</tbody></table>'+(state.profiles.length?'':'<p>No saved servers. Add a server to connect.</p>')+'</article></section>';
}
export function mount(el,context) {
  const s=active={disposed:false,el};
  const error=err=>{if(!s.disposed)el.querySelector('[data-server-error]').textContent=err.kind+': '+err.message;};
  el.oninput=event=>{ if(event.target.id==='servers-filter') el.querySelectorAll('[data-server-row]').forEach(row=>{row.hidden=!row.textContent.toLowerCase().includes(event.target.value.toLowerCase());}); };
  el.onclick=async event=>{
    if(s.disposed)return;
    const btn=event.target.closest('button'); if(!btn)return;
    const profile=state.profiles.find(p=>p.id===(btn.dataset.edit || btn.dataset.remove));if(!profile)return;
    try {
      if(btn.dataset.remove) {if(!await confirmAction({verb:'Remove',object:profile.name,server:profile.host,scope:'Saved server profile',password:'No',explanation:'The saved connection will be removed. Keys and SSH config files are kept.',run:()=>{if(s.disposed)throw {kind:'cancelled',message:'Action cancelled'};return backend.profileRemove(profile.id);}}) || s.disposed)return;if(!s.disposed)await context.profilesChanged();}
      if(btn.dataset.edit) {
        const editor=el.querySelector('[data-server-editor]');
        editor.innerHTML='<form class="server-editor"><h2>Edit server</h2><div class="setup-fields"><div><label for="server-name">Server name</label><input id="server-name" class="field" required maxlength="120" value="'+esc(profile.name)+'"></div><div><label for="server-target">SSH target</label><input id="server-target" class="field" required value="'+esc(profile.host)+'"></div><div class="setup-wide"><label for="server-config">SSH config file</label><input id="server-config" class="field" value="'+esc(profile.config || '')+'"></div></div><div class="setup-actions"><button class="pill" type="button" data-cancel-edit>Cancel</button><button class="pill primary" type="submit">Save changes</button></div></form>';
        editor.querySelector('[data-cancel-edit]').onclick=()=>editor.replaceChildren();
        editor.querySelector('form').onsubmit=async event=>{
          event.preventDefault(); const submit=editor.querySelector('[type="submit"]');submit.disabled=true;
          try { const updated=await backend.profileSave({...profile,name:editor.querySelector('#server-name').value,host:editor.querySelector('#server-target').value,config:editor.querySelector('#server-config').value || null});if(!s.disposed)await context.profilesChanged(updated); }
          catch(err){error(err);submit.disabled=false;}
        };
        editor.querySelector('input').focus();
      }
    }catch(err){error(err);btn.disabled=false;}
  };
  if (state.editServer) { const id = state.editServer; state.editServer = null; el.querySelectorAll('[data-edit]').forEach(b => { if (b.dataset.edit === id) b.click(); }); }
}
export function dispose(){if(active){active.disposed=true;active.el.onclick=null;active.el.oninput=null;}active=null;}
