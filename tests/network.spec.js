const { test, expect } = require('@playwright/test');
const { openServer, openDemo, nav } = require('./helpers');
const data = {
  interfaces: [{ ifname: 'eth0', operstate: 'UP', addr_info: [{local:'192.0.2.2',prefixlen:24},{local:'2001:db8::2',prefixlen:64}] }, {ifname:'down0',operstate:'DOWN',addr_info:[]}],
  routes4: [{dst:'default',gateway:'192.0.2.1',dev:'eth0',metric:100},{dst:'default',gateway:'192.0.2.3',dev:'eth0',metric:200}],
  routes6: [{dst:'default',gateway:'fe80::1',dev:'eth0'},{dst:'2001:db8::/64',dev:'eth0'}],
  ports: [{protocol:'tcp',state:'LISTEN',local:'[::]:22',peer:'[::]:*',process:'sshd'},{protocol:'udp',state:'UNCONN',local:'0.0.0.0:53',peer:'0.0.0.0:*',process:''}],
  firewall: {ufw:'inactive',nftables:'active',firewalld:'inactive',firewalldState:'not running'},
  tailscale: {Self:{HostName:'selfbox',TailscaleIPs:['100.64.0.1'],Online:true,OS:'linux'},peers:[{HostName:'peerbox',TailscaleIPs:['fd7a::2'],Online:true,OS:'linux',LastSeen:'2026-10-01'},{HostName:'sleepbox',TailscaleIPs:[],Online:false,OS:'linux'}]}
};
async function open(page, value=data) { await openServer(page,{network_read:value}); await nav(page,'Network'); await expect(page.locator('.hero h1')).toHaveText('Network'); }
test('all cards, IPv6 and multiple default routes', async ({page})=>{
  await open(page);
  for(const title of ['Interfaces','Routes','Listening ports','Firewall','Tailscale']) await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
  await expect(page.locator('#network-interfaces')).toContainText('2001:db8::2/64');
  await expect(page.locator('.network-default')).toHaveCount(3);
  await expect(page.locator('#network-routes')).toContainText('fe80::1');
  await expect(page.locator('#network-firewall')).toContainText('Permission needed to read rules');
  await expect(page.locator('#network-tailscale')).toContainText('peerbox');
  await expect(page.locator('#network-tailscale')).toContainText('2026-10-01');
  await expect(page.locator('.stats')).toContainText('Interfaces up1');
  await expect(page.locator('.stats')).toContainText('Tailscale peers online1');
  const calls=await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='network_read'));
  expect(calls[0].args.target).toEqual({host:'testbox',config:null});
});
test('port search and TCP UDP tabs combine',async({page})=>{
  await open(page);
  await page.getByRole('button',{name:'TCP',exact:true}).click();
  await expect(page.locator('#network-ports tbody tr:visible')).toHaveCount(1);
  await page.getByRole('searchbox',{name:'Search listening ports'}).fill('53');
  await expect(page.locator('#network-ports tbody tr:visible')).toHaveCount(0);
  await page.getByRole('button',{name:'UDP',exact:true}).click();
  await expect(page.locator('#network-ports tbody tr:visible')).toHaveCount(1);
  await page.getByRole('searchbox',{name:'Search listening ports'}).fill('SSHD');
  await page.getByRole('button',{name:'All',exact:true}).click();
  await expect(page.locator('#network-ports tbody tr:visible')).toHaveCount(1);
});
test('absent tools are unavailable instead of zero',async({page})=>{
  await open(page,{interfaces:null,routes4:null,routes6:null,ports:null,firewall:{},tailscale:null});
  for(const id of ['interfaces','routes','ports','firewall','tailscale']) await expect(page.locator('#network-'+id)).toContainText('Unavailable');
  await expect(page.locator('.stats')).not.toContainText('online0');
});
test('malformed JSON and wrong shapes do not break cards',async({page})=>{
  await open(page,{...data,interfaces:'{broken',routes4:'{}',routes6:'bad',ports:{},tailscale:'{bad'});
  for(const id of ['interfaces','routes','ports','tailscale']) await expect(page.locator('#network-'+id)).toContainText('Unavailable');
  await expect(page.locator('#network-firewall')).toContainText('nftables');
});
test('stopped Tailscale and empty listeners',async({page})=>{
  await open(page,{...data,ports:[],tailscale:{BackendState:'Stopped',Self:data.tailscale.Self,peers:[]}});
  await expect(page.locator('#network-tailscale')).toContainText('Unavailable');
  await expect(page.locator('#network-ports')).toContainText('No listening ports');
});
test('remote text is escaped',async({page})=>{
  const evil='<img src=x onerror="window.injected=true">';
  await open(page,{...data,interfaces:[{ifname:evil,operstate:'UP',addr_info:[]}],ports:[{protocol:'tcp',local:evil,process:evil}],firewall:{ufw:evil},tailscale:{Self:{HostName:evil},peers:[{HostName:evil}]}});
  await expect(page.locator('#network-interfaces')).toContainText(evil);
  expect(await page.locator('#main img').count()).toBe(0);
  expect(await page.evaluate(()=>window.injected)).toBeUndefined();
});
test('typed backend errors are displayed',async({page})=>{
  await openServer(page,{network_read:{error:{kind:'timeout',message:'Network read timed out'}}});
  await nav(page,'Network');
  await expect(page.locator('.error')).toHaveText('Network read timed out');
});
for(const [width,height] of [[800,600],[1024,768],[1280,800],[1440,900],[1920,1080],[2560,1440]]) test('network layout '+width+'x'+height,async({page})=>{
  await page.setViewportSize({width,height}); await open(page);
  expect(await page.evaluate(()=>{
    const bad=[]; if(document.documentElement.scrollWidth>innerWidth+1) bad.push('page');
    for(const e of document.querySelectorAll('header,.hero,.card')) if(e.scrollWidth>e.clientWidth+1) bad.push(e.id||e.className);
    return bad;
  })).toEqual([]);
});
test('default fixture includes Network',async({page})=>{await openDemo(page);await nav(page,'Network');await expect(page.locator('#network-interfaces')).toContainText('eth0');});
