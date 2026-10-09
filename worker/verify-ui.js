// usage: node verify-ui.js <url> <outdir> <tag>
const {chromium}=require('/workspace/command-center-designs/node_modules/playwright');const fs=require('fs');
const [url,out,tag]=process.argv.slice(2);
const pass=fs.readFileSync('/home/box/.nova/passphrase','utf8').trim();
(async()=>{
 const b=await chromium.launch({executablePath:'/usr/bin/google-chrome'});const report={};
 for(const [name,vp,mobile] of [['desktop',{width:1920,height:1080},false],['phone',{width:390,height:844},true]]){
  const ctx=await b.newContext({viewport:vp,deviceScaleFactor:mobile?2:1,isMobile:mobile,hasTouch:mobile,timezoneId:'America/Halifax'});
  const p=await ctx.newPage();const errs=[];
  p.on('console',m=>{if(m.type()==='error'||m.type()==='warning')errs.push(m.type()+': '+m.text())});
  p.on('pageerror',e=>errs.push('pageerror: '+e.message));
  p.on('requestfailed',r=>errs.push('reqfail: '+r.url()+' '+(r.failure()||{}).errorText));
  await p.goto(url,{waitUntil:'networkidle'});
  await p.fill('#pass',pass);await p.click('#go');
  await p.waitForSelector('#lock[hidden]',{state:'attached',timeout:30000});
  await p.waitForFunction(()=>window.NOVA.state.status&&window.NOVA.conn.status,null,{timeout:30000}).catch(()=>errs.push('timeout waiting data'));
  await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(800);
  const s={};
  s.encryptedStatusOk=await p.evaluate(()=>!!(window.NOVA.state.status&&window.NOVA.state.status.agents));
  s.sessionStored=await p.evaluate(()=>!!sessionStorage.getItem('nova.api.session'));
  s.sessionNotInLocal=await p.evaluate(()=>!Object.keys(localStorage).some(k=>k.includes('api.session')));
  s.integrations=await p.evaluate(()=>Object.fromEntries(Object.entries(window.NOVA.conn.status.integrations).map(([k,v])=>[k,v.configured])));
  s.replies=await p.evaluate(()=>[...document.querySelectorAll('.replies .rx')].map(e=>e.textContent.trim()));
  await p.screenshot({path:`${out}/${tag}-${name}-overview.png`,fullPage:mobile});
  await p.selectOption('#cmdtarget','cursor');await p.waitForTimeout(300);
  s.barNoteCursor=await p.evaluate(()=>{const n=document.querySelector('.cmdnote');return n?n.textContent:'(hidden on phone)'});
  await p.fill('#cmdtext','Add a dark mode toggle');await p.click('.cmdsend');await p.waitForTimeout(400);
  s.cursorModal=await p.textContent('#modal .mbox');
  await p.screenshot({path:`${out}/${tag}-${name}-notconnected.png`});
  await p.click('#modal button.x');
  await p.selectOption('#cmdtarget','grok');await p.waitForTimeout(200);
  await p.click('.cmdsend');await p.waitForTimeout(300);
  s.grokModal=(await p.textContent('#modal .mbox')).includes('Not connected yet');
  await p.click('#modal button.x');
  s.draftKept=await p.inputValue('#cmdtext');
  await p.click('[data-conn].connbtn');await p.waitForSelector('#modal .conn');await p.waitForTimeout(500);
  s.connections=await p.evaluate(()=>[...document.querySelectorAll('#modal .crow')].map(r=>(r.querySelector('b')||{}).textContent+': '+((r.querySelector('.badge')||{}).textContent||'')));
  await p.screenshot({path:`${out}/${tag}-${name}-connections.png`});
  if(!mobile) fs.copyFileSync(`${out}/${tag}-${name}-connections.png`,`${out}/connections.png`);
  await p.keyboard.press('Escape');
  await p.reload({waitUntil:'networkidle'});await p.waitForTimeout(2500);
  s.afterReloadUnlocked=await p.evaluate(()=>document.getElementById('lock').hidden);
  s.afterReloadConn=await p.evaluate(()=>!!window.NOVA.conn.status);
  await p.click('[data-lock]');await p.waitForTimeout(300);
  s.afterLockSessionCleared=await p.evaluate(()=>!sessionStorage.getItem('nova.api.session'));
  s.errors=errs;report[name]=s;await ctx.close();
 }
 await b.close();console.log(JSON.stringify(report,null,1));
})();
