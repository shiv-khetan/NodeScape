import { esc, head, search, segTabs } from '../ui/dom.js';
import { state } from '../state.js';
import { words } from '../ui/parse.js';
export function render(txt) {
  const ps = txt.trim().split('\n').filter(Boolean).map(l => { const [pid,user,cpu,mem,etime,...cmd]=words(l);return {pid,user,cpu:+cpu,mem:+mem,etime,cmd:cmd.join(' ')}; });
  const bar = (v,cls) => `<div class="mini"><div class="track"><i class="${cls}" style="width:${Math.min(100,v)}%"></i></div><span>${v.toFixed(1)}%</span></div>`;
  return head('Processes',esc(state.host)+' · '+ps.length+' processes · sorted by CPU',search('process-filter','Search processes').replace('type="search"','type="search" data-list-search'),segTabs('processes','all',[['all','All '+ps.length]])) + `<section class="grid"><article class="card full"><table><thead><tr><th>Process</th><th>PID</th><th>CPU</th><th>Memory</th><th>Running for</th></tr></thead><tbody>${ps.map(p=>`<tr><td><div class="who"><div><p>${esc(p.cmd)}</p><small>${esc(p.user)}</small></div></div></td><td class="num">${esc(p.pid)}</td><td>${bar(p.cpu,'blue')}</td><td>${bar(p.mem,'violet')}</td><td class="num">${esc(p.etime)}</td></tr>`).join('')}</tbody></table></article></section>`;
}
