const { test, expect } = require('@playwright/test');
const { APP, installBackend, openServer, nav, clickService } = require('./helpers');
const F = require('./fixtures');
const card = (page, name) => page.locator('article.card').filter({has:page.getByRole('heading',{name,exact:true})});
async function open(page, options = {}) {
  await installBackend(page, options); await page.goto(APP);
  await expect(page.locator('.page-head h1')).toHaveText('Overview');
  await page.getByRole('button',{name:'Pause live updates',exact:true}).click();
}
const calls = (page, cmd) => page.evaluate(cmd => window.__calls.filter(c=>c.cmd===cmd),cmd);

test('Overview puts actionable problems first and uses the shared header', async ({page})=>{
  await open(page);
  await expect(page.locator('.page-head h1')).toHaveCSS('font-size','20px');
  await expect(page.locator('.page-meta')).toContainText('nas-01 · 10.0.0.3 · updated');
  const problems=page.locator('.problems');
  await expect(page.locator('.overview-grid > :first-child')).toHaveClass(/problems/);
  await expect(problems.getByRole('heading')).toHaveText('2 services failed');
  for(const unit of ['backup.service','zfs-scrub.service']) {
    const row=problems.locator('[data-problem-unit="'+unit+'"]');
    await expect(row).toContainText('failed');
    await expect(row.getByRole('button',{name:'Restart',exact:true})).toBeVisible();
    await expect(row.getByRole('button',{name:'Logs',exact:true})).toBeVisible();
  }
  await expect(problems).toContainText('recent journal errors');
  await problems.locator('[data-svc="restart"]').first().click();
  await expect(page.locator('.confirm-dialog')).not.toContainText(/maybe/i);
  await page.locator('.confirm-dialog').getByRole('button',{name:'Restart backup.service',exact:true}).click();
  await expect(page.locator('#toast')).toContainText('Restarted backup.service');
  await expect(page.locator('.problems h2')).toHaveText('1 service failed');
  await page.locator('.problems [data-unit="zfs-scrub.service"]').click();
  await expect(page.locator('#logunit')).toHaveValue('zfs-scrub.service');
});

test('all clear is quiet and journal-only problems respect limited access', async ({page})=>{
  const healthy=F.SNAPSHOT.replace('backup.service loaded failed failed Backup job','backup.service loaded active running Backup job').replace('error: repository unreachable','Backup completed');
  await open(page,{responses:{snapshot:healthy}});
  await expect(page.locator('.all-clear')).toHaveText('All services running · no recent errors');
  await expect(page.locator('.all-clear')).toHaveClass(/status ok/);
  await expect(page.locator('.problems')).toHaveCount(0);
  await page.evaluate(async snapshot=>{ const {state}=await import('/state.js');const {parseSnapshot}=await import('/ui/parse.js');const {render}=await import('/pages/overview.js');state.snap=parseSnapshot(snapshot);document.querySelector('#main').innerHTML=render(state.snap);},healthy.replace('Backup completed','error: journal problem'));
  await expect(page.locator('.problems')).toContainText('1 recent journal error');
  await page.evaluate(async()=>{const {state}=await import('/state.js');const {render}=await import('/pages/overview.js');state.snap.journalLimited=true;document.querySelector('#main').innerHTML=render(state.snap);});
  await expect(page.locator('.problems')).toHaveCount(0);
});

test('freshness ticks while paused and retains old data after a failed refresh', async ({page})=>{
  await page.clock.install({time:new Date('2026-10-29T00:00:00Z')}); await page.clock.pauseAt(new Date('2026-10-29T00:00:01Z')); await open(page);
  await page.clock.runFor(3000);
  await expect(page.locator('.page-meta')).toContainText('updated 3s ago');
  await page.evaluate(()=>{const invoke=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=(cmd,args)=>cmd==='query'?Promise.reject({kind:'timeout',message:'Snapshot timed out'}):invoke(cmd,args);});
  await page.clock.fastForward(117000); await page.locator('#refresh').click();
  await expect(page.locator('[data-freshness]')).toHaveText('Last updated 2m ago · refresh failed');
  await expect(page.locator('[data-freshness]')).toHaveCSS('color','rgb(188, 41, 70)');
  await expect(card(page,'CPU')).toBeVisible();
  await expect(page.locator('#nav [aria-current]')).toHaveAttribute('data-view','overview');
});

test('charts collect five real samples before occupying chart space', async ({page})=>{
  await open(page);
  for(let n=1;n<=4;n++) {
    await expect(page.locator('.collecting')).toHaveCount(3);
    await expect(card(page,'CPU')).toContainText('Collecting samples ('+n+' of 5)…');
    await expect(page.locator('.bars,.step,.dots,.vs')).toHaveCount(0);
    await page.locator('#refresh').click();
    await expect.poll(()=>page.evaluate(async()=> (await import('/state.js')).history().cpu.length)).toBe(n+1);
  }
  await expect(page.locator('.collecting')).toHaveCount(0);
  await expect(page.locator('.step')).toHaveCount(1);
  await expect(page.locator('.vs')).toHaveCount(2);
});

test('Overview meters, charts, uptime and journal stay flat and calm',async({page})=>{
  await open(page);
  for(let n=0;n<4;n++)await page.locator('#refresh').click();
  await expect(page.locator('.system-strip')).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
  await expect(page.locator('.segline,.svcs .ic')).toHaveCount(0);
  const fills=await page.locator('.meter .track i,.bars i').evaluateAll(items=>items.map(e=>getComputedStyle(e).backgroundImage));
  expect(fills.length).toBeGreaterThan(0);expect(fills.every(v=>v==='none')).toBe(true);
  await expect(page.locator('.timeline .logrow.err')).not.toHaveCount(0);
  expect(await page.locator('.timeline .logrow').evaluateAll(rows=>rows.every(e=>getComputedStyle(e).borderRadius==='0px'&&getComputedStyle(e).boxShadow==='none'))).toBe(true);
  await expect(page.locator('.timeline .logrow.err').first()).toHaveCSS('background-color','rgb(255, 240, 243)');
});

for(const [value,cls,color] of [[84,'neutral','rgb(92, 94, 97)'],[85,'warm','rgb(178, 106, 0)'],[95,'hot','rgb(188, 41, 70)']])test('meter threshold '+value+' is '+cls,async({page})=>{
  await open(page);
  await page.evaluate(async value=>{const {state}=await import('/state.js');const {render}=await import('/pages/overview.js');state.snap.disks=[{target:'/data',size:100,used:value}];state.snap.swap=[100,value,100-value];state.snap.temps=[{label:'Package',celsius:value,crit:100}];document.querySelector('#main').innerHTML=render(state.snap);},value);
  for(const meter of await page.locator('.meter').all()){
    await expect(meter.locator('.track i')).toHaveClass(cls);
    await expect(meter.locator('.track i')).toHaveCSS('background-image','none');
    await expect(meter.locator('.track i')).toHaveCSS('background-color',color);
  }
});

test('temperature labels shorten uniquely and retain disambiguating chips',async({page})=>{
  await open(page);
  await expect(card(page,'Temperatures').locator('.meter-label')).toHaveText(['Package','Core 0']);
  await expect(card(page,'Temperatures').locator('.meter-label').first()).toHaveAttribute('title','coretemp-isa-0000 · Package id 0');
  await expect(card(page,'Temperatures').locator('.meter-label').first()).toHaveCSS('white-space','nowrap');
  const labels=await page.evaluate(async()=>{const {temperatureLabels}=await import('/ui/parse.js');return temperatureLabels([{label:'chip-a · Core 0'},{label:'chip-b · Core 0'},{label:'chip-b · Package id 1'}]);});
  expect(labels).toEqual(['chip-a · Core 0','chip-b · Core 0','Package']);
});

test('service menus offer only valid state and enablement actions',async({page})=>{
  await open(page);await nav(page,'Services');
  for(const [unit,valid,invalid] of [['caddy.service',['restart','stop','disable'],['start','enable']],['apt-daily.service',['start','enable'],['stop','disable']],['backup.service',['start','restart','enable'],['stop','disable']]]){
    const row=page.locator('tbody tr',{hasText:unit});await row.getByRole('button',{name:/More actions/}).click();
    for(const action of valid)await expect(row.locator('[data-svc="'+action+'"]')).toHaveCount(1);
    for(const action of invalid)await expect(row.locator('[data-svc="'+action+'"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
  }
});

test('Manage servers is a table and Remove uses the shared confirmation',async({page})=>{
  await open(page);await page.locator('#manageServers').click();
  await expect(page.locator('thead th')).toHaveText(['Name','Status','Target','Config','Actions']);
  const remove=page.locator('tbody tr').first().getByRole('button',{name:'Remove',exact:true});await expect(remove).toHaveClass(/destructive/);
  await remove.click();await expect(page.locator('.confirm-dialog')).toContainText('Requires administrator password');
  await expect(page.locator('.confirm-dialog')).not.toContainText(/maybe/);
  await page.locator('.confirm-dialog [data-cancel]').click();expect(await calls(page,'profile_remove')).toHaveLength(0);
  await remove.click();await page.locator('.confirm-dialog button.danger').click();await expect.poll(async()=>(await calls(page,'profile_remove')).length).toBe(1);
});

test('Users counts track the visible account set including search and system toggle',async({page})=>{
  await open(page);await nav(page,'Users');
  await expect(page.locator('[data-account-filter="all"]')).toHaveText('All 2');
  await expect(page.locator('[data-account-filter="login"]')).toHaveText('Login users 2');
  await page.getByLabel('Show system accounts').check();
  await expect(page.locator('[data-account-filter="all"]')).toHaveText('All 5');
  await expect(page.locator('[data-account-filter="login"]')).toHaveText('Login users 3');
  await page.getByLabel('Filter users',{exact:true}).fill('alice');
  await expect(page.locator('[data-account-filter="all"]')).toHaveText('All 1');
  await expect(page.locator('#accounts-users tbody tr:visible')).toHaveCount(1);
});

test('shared plurals and ps elapsed time helpers handle singulars and durations',async({page})=>{
  await open(page);
  expect(await page.evaluate(async()=>{const {plural,elapsed}=await import('/ui/dom.js');return [plural(1,'unit'),plural(2,'unit'),plural(1,'sample'),plural(1,'process','processes'),plural(2,'process','processes'),...['6-03:12:44','02:11:00','10:00','00:09'].map(elapsed)];})).toEqual(['1 unit','2 units','1 sample','1 process','2 processes','6d 3h','2h 11m','10m','9s']);
});

test('one refresh, named filter groups and header primary actions on every page',async({page})=>{
  await open(page);
  for(const name of ['Overview','Services','Processes','Logs','Scheduled','Network','Terminal','Files','Users']){
    await nav(page,name);await expect(page.locator('.page-head h1')).toHaveText(name);
    await expect(page.getByRole('button',{name:/^Refresh|^Load$/})).toHaveCount(1);
    for(const group of await page.locator('.segtabs').all())await expect(group).toHaveAccessibleName(/\S+/);
    if(['Files','Users'].includes(name))await expect(page.locator('.header-actions .primary')).toBeVisible();
  }
  await nav(page,'Logs');
  await expect(page.locator('#logunit')).toHaveAttribute('placeholder','Filter by unit…');
  await page.locator('#logunit').fill('caddy');await page.locator('#logunit').press('Tab');
  await expect.poll(async()=>(await calls(page,'logs')).at(-1).args.unit).toBe('caddy');
  await page.locator('#logunit').fill('ssh');await page.locator('#refresh').click();
  await expect.poll(async()=>(await calls(page,'logs')).at(-1).args.unit).toBe('ssh');
});

test('no-server onboarding disables page navigation',async({page})=>{
  await installBackend(page,{host:null,profiles:[]});await page.goto(APP);
  await expect(page.getByRole('heading',{name:'Add a server'})).toBeVisible();
  for(const button of await page.locator('#nav button').all()){await expect(button).toHaveAttribute('aria-disabled','true');await expect(button).toBeDisabled();}
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await expect(page.locator('.segtabs')).toHaveAccessibleName('Connection method');
});

test('confirmed actions expand the same dialog for one-use sudo and wrong passwords',async({page})=>{
  await open(page,{host:'testbox',responses:{snapshot:F.SNAPSHOT,service_action:[{error:{kind:'sudo_required',message:'Password required'}},{error:{kind:'sudo_wrong_password',message:'Wrong'}},'ok']}});
  await nav(page,'Services');await page.locator('[data-svc="stop"][data-u="nginx.service"]').click();
  const dialog=page.locator('.confirm-dialog');await dialog.evaluate(e=>window.__originalConfirm=e);
  await expect(dialog.locator('.confirm-context')).toContainText('Requires administrator passwordYes');await expect(dialog).not.toContainText(/maybe/i);
  await dialog.getByRole('button',{name:'Stop nginx.service',exact:true}).click();
  expect(await dialog.evaluate(e=>e===window.__originalConfirm)).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(dialog).toContainText('Administrator password for testbox');
  const field=dialog.locator('[type="password"]');await expect(field).toHaveAttribute('autocomplete','off');
  await field.fill('synthetic-round2-secret');await dialog.getByRole('button',{name:'Stop nginx.service',exact:true}).click();
  await expect(dialog.getByRole('alert')).toHaveText('Incorrect password. Try again.');
  await expect(field).toHaveValue('');await expect(field).toBeFocused();
  expect(await dialog.evaluate(e=>e===window.__originalConfirm)).toBe(true);
  await field.fill('synthetic-round2-secret');await field.press('Enter');
  await expect(dialog).toHaveCount(0);await expect(page.locator('#toast')).toContainText('Stopped nginx.service');
  expect(await page.evaluate(()=>document.documentElement.outerHTML.includes('synthetic-round2-secret')||JSON.stringify(localStorage).includes('synthetic-round2-secret')||[...document.querySelectorAll('input')].some(i=>i.value.includes('synthetic-round2-secret')))).toBe(false);
});

test('action failures persist as dismissible inline alerts',async({page})=>{
  await page.clock.install();await open(page,{responses:{snapshot:F.SNAPSHOT,service_action:{error:{kind:'permission_denied',message:'Synthetic refusal'}}}});await nav(page,'Services');
  await clickService(page,'start','backup.service');
  const alert=page.locator('#main .action-alert');await expect(alert).toHaveAttribute('role','alert');await expect(alert).toContainText('Synthetic refusal');
  await page.clock.fastForward(10000);await expect(alert).toBeVisible();
  await alert.getByRole('button',{name:'Dismiss error'}).click();await expect(alert).toHaveCount(0);
});

for(const [kind,advice,terminal] of [['unreachable','Check the network or Tailscale connection to testbox',false],['timeout','Check the network or Tailscale connection to testbox',false],['auth_failed','Check the SSH key or agent for testbox',true],['host_key_unknown','fingerprint',false],['host_key_changed','fingerprint',false],['permission_denied','permission',true],['sudo_required','administrator',true],['remote','Synthetic problem',true]])test('error guidance for '+kind,async({page})=>{
  await openServer(page,{snapshot:{error:{kind,message:'Synthetic problem'}}});
  await expect(page.locator('.unreachable')).toContainText(advice);
  await expect(page.locator('#nav [aria-current]')).toHaveAttribute('data-view','overview');
  await expect(page.getByRole('button',{name:'Open terminal',exact:true})).toHaveCount(terminal?1:0);
  await expect(page.locator('.hero h1')).toHaveText('Overview');
  if(kind.startsWith('host_key_')){
    await page.getByRole('button',{name:'Approve host key',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Trust the host key'})).toBeVisible();
    expect((await calls(page,'terminal_open_kind')).at(-1).args).toMatchObject({target:{host:'testbox',config:null},kind:'trust_host'});
  }
});
