const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const html = fs.readFileSync('index.html', 'utf8');
const script = fs.readFileSync('ai-upload.js', 'utf8');
function setup(enabled=true) {
  const dom = new JSDOM(html, {url:'https://krintea.github.io/cornu-house-expenses/', runScripts:'outside-only'});
  const w = dom.window;
  w.eval = code => require('node:vm').runInContext(code, dom.getInternalVMContext());
  w.HTMLDialogElement.prototype.showModal = function(){ this.open=true; };
  w.HTMLDialogElement.prototype.close = function(){ this.open=false; this.dispatchEvent(new w.Event('close')); };
  w.confirm=()=>true;
  w.eval([...w.document.scripts].find(s=>s.textContent.includes('function createEmptyState')).textContent);
  w.eval('loadSampleData(true)');
  w.document.getElementById('firstRunDialog').close();
  w.CORNU_AI_CONFIG={enabled, apiUrl:'https://test.run.app', googleClientId:'client'};
  let login;
  w.google={accounts:{id:{initialize(c){login=c.callback}, renderButton(){}, disableAutoSelect(){}}}};
  w.eval(script);
  w.eval('openPaymentDialog()');
  const el=id=>w.document.getElementById(id);
  const connect=()=>{el('aiConnect').click(); login({credential:'test-token'});};
  const file=()=>Object.defineProperty(el('aiFile'),'files',{configurable:true,value:[new w.File(['test'], 'invoice.pdf',{type:'application/pdf'})]});
  const category=w.eval('getSortedCategories()[0].id');
  const result={payment:{beneficiary:'Furnizor Fictiv',description:'Beton',amount:1234.56,currency:'RON',paymentDate:'2026-11-20',invoiceDate:'2026-11-19',invoiceNumber:'TEST-1',categoryId:category,subcategoryId:null,warnings:['Verifică totalul.']}};
  const tick=()=>new Promise(r=>setImmediate(r));
  return {dom,w,el,connect,file,result,tick};
}
test('fills existing form, does not save, supports undo and duplicate warning', async()=>{
  const {dom,w,el,connect,file,result,tick}=setup();
  const count=w.eval('state.payments.length');
  w.eval(`state.payments.push({id:'duplicate', beneficiary:'Furnizor Fictiv',date:'2026-11-20', originalAmount:1234.56, originalCurrency:'RON'})`);
  w.fetch=async(url,options)=>{assert.equal(String(url),'https://test.run.app/analyze');assert.equal(options.headers.Authorization,'Bearer test-token');return {ok:true,status:200,json:async()=>result};};
  connect();file();el('aiAnalyze').click();await tick();
  assert.equal(el('paymentBeneficiary').value,'Furnizor Fictiv');
  assert.equal(el('paymentAmount').value,'1234.56');
  assert.equal(w.eval('state.payments.length'), count+1);
  assert.equal(el('duplicateWarning').classList.contains('hidden'),false);
  el('aiUndo').click();assert.equal(el('paymentBeneficiary').value,'');
  dom.window.close();
});
test('unknown date and currency do not become today or RON', async()=>{
  const {dom,w,el,connect,file,result,tick}=setup();
  Object.assign(result.payment,{paymentDate:null,currency:null,amount:null,categoryId:null});
  w.fetch=async()=>({ok:true,status:200,json:async()=>result});
  connect();file();el('aiAnalyze').click();await tick();
  for(const id of ['paymentDate','paymentAmount','paymentCurrency','paymentCategory']) assert.equal(el(id).value,'');
  assert.equal(el('paymentForm').checkValidity(),false);dom.window.close();
});
test('preserves user edits made while request is pending', async()=>{
  const {dom,w,el,connect,file,result,tick}=setup(); let resolve;
  w.fetch=()=>new Promise(r=>resolve=r);connect();file();el('aiAnalyze').click();
  el('paymentBeneficiary').value='Manual edit';
  resolve({ok:true,status:200,json:async()=>result});await tick();
  assert.equal(el('paymentBeneficiary').value,'Manual edit');dom.window.close();
});
test('late response after closing and reopening cannot overwrite next payment', async()=>{
  const {dom,w,el,connect,file,result,tick}=setup();let resolve;
  w.fetch=()=>new Promise(r=>resolve=r);connect();file();el('aiAnalyze').click();
  el('paymentDialog').close();w.eval('openPaymentDialog()');
  resolve({ok:true,status:200,json:async()=>result});await tick();
  assert.equal(el('paymentBeneficiary').value,'');dom.window.close();
});
test('expired auth leaves form intact and requires reconnect', async()=>{
  const {dom,w,el,connect,file,tick}=setup(); let calls=0;
  w.fetch=async()=>{calls++;return {ok:false,status:401,json:async()=>({error:'Expired'})}};
  connect();file();el('aiAnalyze').click();await tick();el('aiAnalyze').click();await tick();
  assert.equal(calls,1);assert.equal(el('paymentBeneficiary').value,'');dom.window.close();
});
test('untrusted warning renders as text, never markup', async()=>{
  const {dom,w,el,connect,file,result,tick}=setup();result.payment.warnings=['<img src=x onerror=alert(1)>'];
  w.fetch=async()=>({ok:true,status:200,json:async()=>result});connect();file();el('aiAnalyze').click();await tick();
  assert.equal(el('aiWarnings').querySelector('img'),null);assert.match(el('aiWarnings').textContent,/<img/);dom.window.close();
});
test('disabled feature retains manual save, editing, and backup schema',()=>{
  const {dom,w,el}=setup(false);assert.equal(el('aiActions').hidden,true);
  const count=w.eval('state.payments.length');
  el('paymentBeneficiary').value='Manual supplier';el('paymentAmount').value='99.50';
  el('paymentForm').dispatchEvent(new w.Event('submit',{cancelable:true}));
  assert.equal(w.eval('state.payments.length'),count+1);
  assert.equal(w.eval('isValidState(JSON.parse(localStorage.getItem(STORAGE_KEY)))'),true);
  w.eval('openPaymentDialog(state.payments.at(-1).id)');assert.equal(el('aiUploadPanel').hidden,true);
  assert.equal(el('paymentBeneficiary').value,'Manual supplier');dom.window.close();
});
test('Drive save, restore and test still work against mocked Drive API', async()=>{
  const {dom,w,el,tick}=setup(false);let saved;let deleted=false;
  w.google.accounts.oauth2={initTokenClient(c){return {requestAccessToken(){c.callback({access_token:'drive-token'})}}},hasGrantedAllScopes(){return true}};
  w.fetch=async(url,options={})=>{
    assert.equal(options.headers.Authorization,'Bearer drive-token');
    if(options.method==='POST') {
      const parts=options.body.split('\r\n\r\n');saved=JSON.parse(parts[2].split('\r\n--')[0]);
      return {ok:true,json:async()=>({id:'mock-file'})};
    }
    if(options.method==='DELETE'){deleted=true;return {ok:true};}
    if(String(url).includes('alt=media'))return {ok:true,json:async()=>saved};
    return {ok:true,json:async()=>({files:[{id:'mock-file',createdTime:'2026-11-20T12:00:00Z'}]})};
  };
  w.eval([...w.document.scripts].find(s=>s.textContent.includes("const scope = 'https://www.googleapis.com/auth/drive.appdata'")).textContent);
  el('driveSave').click();await tick();assert.match(el('driveStatus').textContent,/salvată și verificată/);
  const count=saved.payments.length;w.eval('state.payments=[]');el('driveLoad').click();await tick();
  assert.equal(w.eval('state.payments.length'),count);
  el('driveTest').click();await tick();assert.equal(deleted,true);assert.match(el('driveStatus').textContent,/Test reușit/);
  dom.window.close();
});
