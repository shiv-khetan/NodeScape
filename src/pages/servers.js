import * as backend from '../backend.js';
import { state } from '../state.js';
import { esc, head } from '../ui/dom.js';
let active;
export function render() {
  return head('Manage servers', '', '<button class="pill primary" data-go="onboarding">Add server</button>') + '<section class="onboarding"><article class="card servers-card">'+(state.profileWarning?'<p class="notice">'+esc(state.profileWarning)+'</p>':'')+'<p>Saved servers contain connection details only. Passwords and private keys are never stored.</p><div data-server-editor></div><p data-server-error role="alert"></p><div class="server-list">'+state.profiles.map(p=>'<div data-server-row><div class="who"><div class="ic">'+esc(p.name.slice(0,1))+'</div><div><b>'+esc(p.name)+'</b><p>'+esc(p.host)+'</p><small>'+esc(p.config || 'Default OpenSSH config')+'</small></div></div><div class="acts"><button data-edit="'+esc(p.id)+'">Edit</button><button data-remove="'+esc(p.id)+'">Remove</button></div></div>').join('')+(state.profiles.length?'':'<p>No saved servers. Add a server to connect.</p>')+'</div></article></section>';
}
export function mount(el,context) {
  const s=active={disposed:false,el};
  const error=err=>{if(!s.disposed)el.querySelector('[data-server-error]').textContent=err.kind+': '+err.message;};
  el.onclick=async event=>{
    if(s.disposed)return;
    const btn=event.target.closest('button'); if(!btn)return;
    const profile=state.profiles.find(p=>p.id===(btn.dataset.edit || btn.dataset.remove));if(!profile)return;
    try {
      if(btn.dataset.remove) {if(!confirm('Remove “'+profile.name+'” from saved servers? Keys and SSH config files are kept.'))return;btn.disabled=true;await backend.profileRemove(profile.id);if(!s.disposed)await context.profilesChanged();}
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
}
export function dispose(){if(active){active.disposed=true;active.el.onclick=null;}active=null;}
