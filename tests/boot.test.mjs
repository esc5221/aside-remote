// UI boot smoke test — loads web/index.html in jsdom with a mocked API and
// walks the core flows (list, open, navigate, drawer, search, dead deep-link).
// Run:  npm i jsdom && node tests/boot.test.mjs
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const html = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../web/index.html'), 'utf8');
const SESS = [{id:'AAA',title:'대화 A',preview:'a',mtime:2,updatedAt:'2026-01-02T00:00:00Z',unread:false},
              {id:'BBB',title:'대화 B',preview:'b',mtime:1,updatedAt:'2026-01-01T00:00:00Z',unread:false}];
let failures = 0;
const t = (name, cond) => { console.log(`  ${cond?'✓':'✗'} ${name}`); if(!cond) failures++; };

async function boot(url, width, msgs, opts={}){
  const errs=[], calls=[], gone=opts.gone||new Set();
  const dom = new JSDOM(html,{url,runScripts:'dangerously',pretendToBeVisual:true,
    beforeParse(w){
      w.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
      w.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
      w.innerWidth=width;
      w.matchMedia=()=>({matches:false,addEventListener(){},addListener(){}});
      w.fetch=async (u,o={})=>(calls.push([o.method||'GET',u]), {ok:true,status:200,headers:{get:()=>'application/json'},
        blob:async()=>new w.Blob(['x'],{type:'image/jpeg'}),
        json:async()=> o.method==='DELETE' ? (gone.add(u.split('/').pop()), {deleted:true})
          : u.includes('/api/sessions?') ? (l=>({items:l,nextCursor:null,total:l.length,matched:l.length}))(
              SESS.filter(x=>!gone.has(x.id)).map(x=>({...x})))
          : u.includes('/messages') ? (u.includes('ZZZ')
              ? {messages:[],nextSeq:0,offset:0,running:false}
              : {messages:msgs||[{seq:0,role:'user',blocks:[{type:'text',text:'hi'}]}],nextSeq:(msgs||[1]).length,offset:10,running:false})
          : u.includes('web-token') ? {token:'t'} : u.includes('health') ? {ok:true}
          : u.includes('font/list') ? {fonts:[]} : u.includes('/api/tabs') ? {tabs:opts.tabs||[]} : {},
        text:async()=>''});
      w.URL.createObjectURL=()=>'blob:x'; w.URL.revokeObjectURL=()=>{};
      w.WebSocket=class{constructor(){this.readyState=1;w.__ws=this;}send(){}close(){}};
      w.WebSocket.OPEN=1;
      w.onerror=(m,s,l,c,e)=>errs.push(String(e?.message||m));
      w.addEventListener('unhandledrejection',e=>errs.push(String(e.reason?.message||e.reason)));
    }});
  await new Promise(r=>setTimeout(r,350));
  return {w:dom.window,d:dom.window.document,errs,calls,gone};
}

console.log('mobile boot /');
{ const {w,d,errs}=await boot('http://localhost/',400);
  t('no JS errors', errs.length===0);
  t('cards rendered', d.querySelectorAll('.card').length===2);
  d.querySelector('#menu').click(); await new Promise(r=>setTimeout(r,50));
  t('hamburger opens drawer', d.body.classList.contains('drawer'));
  d.querySelector('.card').click(); await new Promise(r=>setTimeout(r,150));
  t('card click routes to /c/<id>', w.location.pathname==='/c/AAA');
  t('drawer closed after pick', !d.body.classList.contains('drawer'));
  w.history.back(); await new Promise(r=>setTimeout(r,100));
  t('back reopens drawer', d.body.classList.contains('drawer')); }

console.log('desktop deep link /c/BBB');
{ const {w,d,errs}=await boot('http://localhost/c/BBB',1400);
  t('no JS errors', errs.length===0);
  t('messages rendered', d.querySelectorAll('#msgs .user,#msgs .asst').length>0);
  d.querySelectorAll('.seg')[1].click(); await new Promise(r=>setTimeout(r,100));
  t('segment routes to /tabs', w.location.pathname==='/tabs');
  w.history.back(); await new Promise(r=>setTimeout(r,100));
  t('back returns to /c/BBB', w.location.pathname==='/c/BBB'); }

console.log('search deep link /?q=…');
{ const {d,errs}=await boot('http://localhost/?q=%EB%8C%80%ED%99%94',1400);
  t('no JS errors', errs.length===0);
  t('search box prefilled', d.querySelector('#sq')?.value==='대화'); }

console.log('dead session deep link');
{ const {w,errs}=await boot('http://localhost/c/ZZZdead',1400);
  await new Promise(r=>setTimeout(r,150));
  t('no JS errors', errs.length===0);
  t('URL replaced to /', w.location.pathname==='/'); }

console.log('tool details keep open state across re-render');
{ const MSGS=[{seq:0,role:'user',blocks:[{type:'text',text:'go'}]},
    {seq:1,role:'assistant',blocks:[{type:'thinking',text:'plan\nmore'},{type:'toolCall',name:'repl',args:{code:'1+1'}}]},
    {seq:2,role:'toolResult',toolName:'repl',blocks:[{type:'text',text:'2'}]}];
  const {w,d,errs}=await boot('http://localhost/c/BBB',1400,MSGS);
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const act=()=>d.querySelector('#msgs details.act');
  t('act pill rendered, collapsed', !!act() && !act().open);
  act().open=true; await wait(30);
  d.querySelector('#msgs details.tool').open=true; await wait(30);
  w.eval('renderChat()'); w.eval('renderChat()'); await wait(30);
  t('act stays open after re-render', act().open);
  t('inner tool stays open after re-render', d.querySelector('#msgs details.tool').open);
  t('untouched thinking stays closed', !d.querySelector('#msgs details.think').open);
  d.querySelector('#msgs details.tool').open=false; await wait(30);
  w.eval('renderChat()'); await wait(30);
  t('user-closed tool stays closed', !d.querySelector('#msgs details.tool').open);
  t('no JS errors', errs.length===0); }

console.log('theme presets');
{ const {w,d,errs}=await boot('http://localhost/settings',1400);
  const root=d.documentElement;
  t('auto resolves to light', root.dataset.theme==='light');
  t('theme buttons rendered', d.querySelectorAll('.themebtn').length===4);
  d.querySelector('.themebtn[data-theme-id="linear"]').click();
  t('linear applied', root.dataset.theme==='linear');
  t('choice saved', w.localStorage.getItem('theme')==='linear');
  t('theme.css linked after styles', !!d.querySelector('link[href="/theme.css"]'));
  t('no JS errors', errs.length===0); }

console.log('conversation delete');
{ const {w,d,errs,calls,gone}=await boot('http://localhost/c/AAA',1400);
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  t('delete button outside card button', d.querySelectorAll('.cdel').length===2 && !d.querySelector('.card .cdel'));
  d.querySelector('.cdel[data-del="AAA"]').click(); await wait(30);
  t('confirm dialog shown', !!d.querySelector('.mask #delOk'));
  d.querySelector('#delNo').click(); await wait(80);
  t('cancel closes dialog', !d.querySelector('.mask'));
  t('cancel sends nothing', !calls.some(c=>c[0]==='DELETE'));
  d.querySelector('.cdel[data-del="AAA"]').click(); await wait(30);
  d.querySelector('#delOk').click(); await wait(200);
  t('DELETE sent', calls.some(c=>c[0]==='DELETE' && c[1]==='/api/sessions/AAA'));
  t('dialog closed', !d.querySelector('.mask'));
  t('open conversation cleared → /', w.location.pathname==='/');
  gone.add('BBB');   // 다른 기기에서 지워졌다
  w.__ws.onmessage({data:JSON.stringify({op:'session.deleted',sessionId:'BBB'})}); await wait(60);
  t('session.deleted from other device removes card', !d.querySelector('.card[data-id="BBB"]'));
  t('no JS errors', errs.length===0); }

console.log('browser live preview');
{ const TABS=[{targetId:'T1',title:'탭',url:'https://e.x',loaded:true,active:true}];
  const {w,d,errs,calls}=await boot('http://localhost/',1400,null,{tabs:TABS});
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  d.querySelector('#browserPreview').click(); await wait(150);
  t('preview sheet opened', !!d.querySelector('.mask .shot'));
  t('fresh shot fetched', calls.some(c=>c[1].startsWith('/api/tabs/T1/shot?fresh=true')));
  t('image set', d.querySelector('.mask .shot').src==='blob:x');
  d.querySelector('#pvPause').click(); await wait(20);
  t('pause toggles label', d.querySelector('#pvPause').textContent==='다시 시작');
  w.history.back(); await wait(80);
  t('closing sheet stops preview', !d.querySelector('.mask') && w.eval('tabPreview')===null);
  t('no JS errors', errs.length===0); }

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures?1:0);
