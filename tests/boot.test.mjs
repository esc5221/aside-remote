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

async function boot(url, width, msgs){
  const errs=[];
  const dom = new JSDOM(html,{url,runScripts:'dangerously',pretendToBeVisual:true,
    beforeParse(w){
      w.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
      w.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
      w.innerWidth=width;
      w.matchMedia=()=>({matches:false,addEventListener(){},addListener(){}});
      w.fetch=async u=>({ok:true,status:200,headers:{get:()=>'application/json'},
        json:async()=> u.includes('/api/sessions?') ? {items:SESS.map(x=>({...x})),nextCursor:null,total:2,matched:2}
          : u.includes('/messages') ? (u.includes('ZZZ')
              ? {messages:[],nextSeq:0,offset:0,running:false}
              : {messages:msgs||[{seq:0,role:'user',blocks:[{type:'text',text:'hi'}]}],nextSeq:(msgs||[1]).length,offset:10,running:false})
          : u.includes('web-token') ? {token:'t'} : u.includes('health') ? {ok:true}
          : u.includes('font/list') ? {fonts:[]} : u.includes('/api/tabs') ? {tabs:[]} : {},
        text:async()=>''});
      w.WebSocket=class{constructor(){this.readyState=1;}send(){}close(){}};
      w.onerror=(m,s,l,c,e)=>errs.push(String(e?.message||m));
      w.addEventListener('unhandledrejection',e=>errs.push(String(e.reason?.message||e.reason)));
    }});
  await new Promise(r=>setTimeout(r,350));
  return {w:dom.window,d:dom.window.document,errs};
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

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures?1:0);
