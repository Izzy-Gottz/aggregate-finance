// The /try page: the "Try it" chat (try-chat.ts) in the docs frame. Answers are shown as plain text, never as HTML.
import { renderDoc, type LegalFonts, type LegalPage } from './legal.ts'
import { TRY_MAX_QUESTIONS } from './try-chat.ts'

export const TRY_JS_PATH = '/assets/try.js'

const ASKS = ['What’s Northwind’s cash runway?', 'Why don’t Stripe payouts match the bank?', 'What does Bluebird have in unpaid invoices?']

const CONNECT = `<p class="tpaused-links"><a href="/docs/guides/connect-claude">Connect to Claude</a> · <a href="/docs/guides/connect-chatgpt">Connect to ChatGPT</a> · <a href="%AGFN_BASE_URL%/?start=1">Sign up</a></p>`

const CSS = `<style>
.tasks{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0}
.tasks button{min-height:40px;padding:0 14px;border-radius:20px;border:1px solid var(--hairline);background:var(--card);color:var(--ink);font:400 14px var(--sans);cursor:pointer;text-align:left}
.tlog{margin:8px 0 0}
.tq{margin:24px 0 6px;font-weight:500}
.ta{margin:0;white-space:pre-wrap;color:var(--ink);line-height:1.6}
.ta.wait{color:var(--muted)}
.tform{display:flex;gap:8px;margin:24px 0 8px}
.tform textarea{flex:1;min-height:44px;max-height:160px;padding:10px 14px;border:1px solid var(--hairline);border-radius:10px;background:var(--card);font:inherit;font-size:16px;color:var(--ink);resize:vertical}
.tform textarea:focus{outline:0;border-color:var(--ink)}
.tform button{min-height:44px;padding:0 18px;border-radius:10px;border:0;background:var(--ink);color:var(--bg);font:500 15px var(--sans);cursor:pointer}
.tform button:disabled{opacity:.5;cursor:default}
.tpaused{margin:24px 0;padding:16px 18px;border:1px solid var(--hairline);border-radius:12px;background:var(--card)}
.tpaused p{margin:0}.tpaused .tpaused-links{margin-top:8px}
.tasks[hidden],.tform[hidden],.tpaused[hidden]{display:none}
</style>`

function body(): string {
  return `${CSS}<h1>Try it</h1>
<p>Ask about a sample company. Demo data only, nothing real: three made-up companies and a personal set, already connected. Aggregate is free during beta.</p>
<div class="tasks" role="group" aria-label="Example questions">${ASKS.map((q) => `<button type="button">${q}</button>`).join('')}</div>
<div class="tlog" aria-live="polite"></div>
<div class="tpaused" hidden><p></p>${CONNECT}</div>
<form class="tform"><label class="dsr" for="tq">Your question</label><textarea id="tq" rows="1" maxlength="1000" placeholder="Ask about the sample companies" required></textarea><button type="submit">Ask</button></form>
<p class="dfine">Claude answers by reading the demo through the same Aggregate tools your own AI would use. Your question is sent to Anthropic to answer it. Aggregate doesn’t store your questions; it only counts them to keep the demo within its limits. Up to ${TRY_MAX_QUESTIONS} questions per chat.</p>
<script src="${TRY_JS_PATH}" defer></script>`
}

export function renderTryPage(fonts: LegalFonts): LegalPage {
  const md = '---\ntitle: Try it\ndescription: Ask an AI about a sample company’s finances through Aggregate. No sign-up; demo data only.\n---\n'
  return renderDoc(md, fonts, '/try', { body })
}

export const TRY_JS = `(function(){
var form=document.querySelector('.tform');if(!form)return;
var input=form.querySelector('textarea'),send=form.querySelector('button'),log=document.querySelector('.tlog'),paused=document.querySelector('.tpaused'),msgs=[],MAX=${TRY_MAX_QUESTIONS};
var stop=function(text){paused.querySelector('p').textContent=text;paused.hidden=false;form.hidden=true;document.querySelector('.tasks').hidden=true};
var ask=function(q){q=q.trim();if(!q||send.disabled)return;
var qe=document.createElement('p');qe.className='tq';qe.textContent=q;var ae=document.createElement('p');ae.className='ta wait';ae.textContent='Reading the demo’s books…';log.appendChild(qe);log.appendChild(ae);
send.disabled=true;input.value='';var next=msgs.concat([{role:'user',content:q}]);
fetch('/api/try',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:next})}).then(function(r){return r.json()}).then(function(j){
if(j.answer){msgs=next.concat([{role:'assistant',content:j.answer}]);ae.className='ta';ae.textContent=j.answer;
if(msgs.length>=MAX*2){stop('That’s '+MAX+' questions for this chat. Reload the page to start over, or connect Aggregate to your own Claude or ChatGPT.')}}
else{log.removeChild(ae);log.removeChild(qe);stop(j.message||'Demo chat is paused — connect Aggregate to your own Claude or ChatGPT.')}
}).catch(function(){log.removeChild(ae);log.removeChild(qe);stop('Demo chat is paused — connect Aggregate to your own Claude or ChatGPT.')}).finally(function(){send.disabled=false})};
form.addEventListener('submit',function(e){e.preventDefault();ask(input.value)});
input.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();ask(input.value)}});
document.querySelectorAll('.tasks button').forEach(function(b){b.addEventListener('click',function(){ask(b.textContent)})});
})();`
