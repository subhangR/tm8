import { chromium, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--no-zygote','--single-process','--disable-gpu','--disable-dev-shm-usage'],...(process.env.MCP_CHROMIUM_PATH?{executablePath:process.env.MCP_CHROMIUM_PATH}:{})});
const base=process.env.MCP_UI_URL??'http://127.0.0.1:4639';
const results=[];
try {
 const page=await browser.newPage();
 for(const width of [1280,768,390,320]){
  await page.setViewportSize({width,height:900});
  page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${base}/e2e/mcp-harness.html`);
  await page.getByRole('button',{name:'Manage Calendar'}).click();
  await page.getByRole('combobox',{name:'Test with account'}).selectOption('work');
  await page.getByRole('button',{name:'Test and discover tools'}).click();
  await page.getByText('list_events',{exact:true}).waitFor();
  await page.getByRole('combobox',{name:'Account sharing'}).selectOption('members');
  await page.getByRole('checkbox',{name:'Ada',exact:true}).check();
  await page.getByRole('button',{name:'Save sharing'}).click();
  await page.getByRole('status').filter({hasText:'Account sharing updated.'}).waitFor();
  await page.getByRole('button',{name:'All connectors'}).click();
  await page.getByRole('button',{name:'Manage Calendar'}).click();
  if(!await page.getByRole('checkbox',{name:'Ada',exact:true}).isChecked())throw Error('reopened member missing');
  const picker=page.getByRole('group',{name:'Connectors',exact:true});
  await picker.getByRole('checkbox',{name:/Calendar/}).check();
  await expect(page.getByRole('button',{name:'Launch session'})).toBeDisabled();
  await picker.getByRole('combobox',{name:'Account for Calendar'}).selectOption('work');
  await expect(page.getByRole('button',{name:'Launch session'})).toBeEnabled();
  await page.getByRole('checkbox',{name:'Calendar',exact:true}).last().check();
  await page.getByRole('button',{name:'Revoke account',exact:true}).click();
  await page.getByRole('button',{name:'Confirm revoke',exact:true}).click();
  await picker.getByRole('link',{name:'Connect Calendar',exact:true}).waitFor();
  await expect(page.getByRole('button',{name:'Launch session'})).toBeDisabled();
  await page.getByRole('button',{name:'Add connector',exact:true}).click();
  const name=page.getByLabel('Name',{exact:true});
  await name.fill('Personal Calendar');
  if(await name.evaluate(input=>input.checkValidity()))throw Error('invalid connector name accepted');
  await name.fill('personal-calendar');
  if(!await name.evaluate(input=>input.checkValidity()))throw Error('valid connector name refused');
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
  if(overflow)throw Error(`horizontal overflow at ${width}`);
  await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
  const axe=await page.evaluate(async()=>window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa']}}));
  const violations=axe.violations.map(v=>({id:v.id,nodes:v.nodes.length,description:v.description}));
  if(violations.length)throw Error(JSON.stringify({width,violations}));
  if(errors.length)throw Error(JSON.stringify(errors));
  results.push({width,passed:true,checks:['account test/tools','selected-member sharing and reopen','immediate revocation readiness','HTML name validation','explicit account readiness','attachment','no horizontal overflow','axe WCAG A/AA','no page errors']});

 }
 console.log(JSON.stringify({results},null,2));
} finally {await browser.close();}
