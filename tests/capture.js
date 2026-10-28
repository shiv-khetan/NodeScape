// Run against the local fixture server; screenshots stay outside the shipping src tree.
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
async function capture() {
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage();
  const fixture = await fs.readFile(path.join(__dirname,'fixtures/demo-backend.js'),'utf8');
  await page.addInitScript({content:fixture+'\nwindow.installDemoBackend();'});
  const dir = path.join(__dirname,'test-results/visual'); await fs.mkdir(dir,{recursive:true});
  for (const [width,height] of [[1440,900],[1000,800]]) {
    await page.setViewportSize({width,height});
    await page.goto('http://127.0.0.1:'+(process.env.NODESCAPE_TEST_PORT || 4220));
    await page.waitForSelector('.hero h1'); await page.locator('#refresh').click();await page.waitForSelector('.step svg');
    await page.locator('[data-act="live"]').click();
    for (const [view,name] of [['overview','Overview'],['services','Services'],['processes','Processes'],['logs','Logs'],['timers','Scheduled'],['network','Network'],['terminal','Terminal'],['files','Files'],['accounts','Users'],['servers','Manage servers'],['onboarding','Add a server']]) {
      await page.locator(view==='servers'?'#manageServers':view==='onboarding'?'#addServer':'[data-view="'+view+'"]').click();
      await page.getByRole('heading',{name,exact:true}).first().waitFor();
      if(view==='files') await page.waitForFunction(()=>document.querySelector('#files-path').value==='/');
      if(view==='terminal') await page.waitForFunction(()=>document.querySelector('[data-terminal-status]').textContent==='Connected');
      await page.screenshot({path:path.join(dir,view+'-'+width+'.png'),fullPage:true});
    }
    await page.locator('[data-view="services"]').click(); await page.waitForSelector('tbody tr');
    await page.locator('tbody tr').first().getByRole('button',{name:/More actions/}).click();
    await page.locator('.row-menu:popover-open').waitFor();
    await page.screenshot({path:path.join(dir,'menu-'+width+'.png'),fullPage:false}); await page.keyboard.press('Escape');
    await page.locator('tr[data-st="running"] [data-svc="stop"]').first().click(); await page.waitForSelector('.confirm-dialog');
    await page.screenshot({path:path.join(dir,'confirm-'+width+'.png'),fullPage:false}); await page.locator('.confirm-dialog [data-cancel]').click();
    await page.evaluate(()=>{const invoke=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=(cmd,args)=>cmd==='query'&&args.what==='snapshot'?Promise.reject({kind:'timeout',message:'ssh: synthetic connection timed out'}):invoke(cmd,args);});
    await page.locator('[data-view="overview"]').click(); await page.waitForSelector('.empty pre');
    await page.screenshot({path:path.join(dir,'error-'+width+'.png'),fullPage:true});
  }
  await browser.close();
}
capture().catch(error=>{console.error(error);process.exitCode=1;});
