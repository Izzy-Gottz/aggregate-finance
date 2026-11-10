// The /try page: the "Try it" chat (try-chat.ts) on a page of its own. Empty, it's a title, the input and a few questions;
// once a chat starts the messages scroll above and the input stays pinned at the foot. Answers are plain text, never HTML.
import { renderDoc, type LegalFonts, type LegalPage } from './legal.ts'
import { TRY_MAX_QUESTIONS } from './try-chat.ts'

export const TRY_JS_PATH = '/assets/try.js'

/** Example questions by topic. Each is answerable from the public demo's data with the demo's own tools; dc checked every
 *  answer on 2026-11-04 (~/aggregate-drafts/accuracy/try-it-chat-key.md). They're shown in the empty chat and behind the + by the input. */
export const TRY_IDEAS: Array<{ topic: string; asks: string[] }> = [
  {
    topic: 'Cash and runway',
    asks: [
      'How much cash did my companies have on October 31, 2026?',
      'What’s Northwind’s runway?',
      'Is Harbor Coffee burning cash?',
      'Which accounts hold Harbor Coffee’s cash?',
      'What’s due in the next 30 days across all my companies?',
    ],
  },
  {
    topic: 'Revenue and sales',
    asks: [
      'What was Northwind Labs’ revenue in October 2026?',
      'What is Northwind Labs’ MRR, and how did it move from January to October 2026?',
      'How did Harbor Coffee’s revenue for Jan to Oct 2026 compare with Jan to Oct 2025?',
      'How much did Northwind pay in Stripe fees in October 2026?',
    ],
  },
  {
    topic: 'Spending and burn',
    asks: [
      'What were Northwind’s net burn and runway as of October 31, 2026?',
      'Which of Northwind’s recurring charges went up in price?',
      'What did Bluebird Studio spend most on in October 2026?',
      'How did Harbor Coffee’s spending in October 2026 compare with September?',
    ],
  },
  {
    topic: 'Payroll',
    asks: [
      'What did Northwind’s payroll cost in October 2026?',
      'When is Northwind’s next payroll, and about how much?',
      'How many employees are on each company’s payroll?',
    ],
  },
  {
    topic: 'Invoices and AR',
    asks: [
      'What does Bluebird Studio have in unpaid invoices?',
      'What payments are coming up in the next two weeks?',
      'How much has Bluebird Studio’s biggest client paid from January to October 2026?',
    ],
  },
  {
    topic: 'Reconciliation and review',
    asks: [
      'Do Northwind’s Stripe payouts match its bank deposits?',
      'What’s waiting for review, and what would each item change?',
      'Does Northwind Labs owe the founder any money?',
      'Is any month missing data for Harbor Coffee?',
    ],
  },
  {
    topic: 'Investments',
    asks: [
      'What’s in the Personal investment accounts?',
      'How much has Northwind raised on SAFEs, and did it show up as revenue?',
      'Who owns what on Northwind’s cap table?',
    ],
  },
]

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const CONNECT = `<p class="tpaused-links"><a href="/docs/guides/connect-claude">Connect to Claude</a> · <a href="/docs/guides/connect-chatgpt">Connect to ChatGPT</a> · <a href="%AGFN_BASE_URL%/?start=1">Sign up</a></p>`

/** The questions shown under the empty input; the rest are behind "More questions". Each is one of TRY_IDEAS. */
export const TRY_FEATURED = [
  'How much cash did my companies have on October 31, 2026?',
  'What’s Northwind’s runway?',
  'What was Northwind Labs’ revenue in October 2026?',
  'Do Northwind’s Stripe payouts match its bank deposits?',
]

const PLUS = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 3v12M3 9h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
const UP = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 15V3M4 8l5-5 5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'

const CSS = `<style>
.tpage{max-width:712px;margin:0 auto;padding:12vh 16px 24px}
.tpage h1{font:300 56px/60px var(--serif);letter-spacing:-.02em;margin:0 0 12px;text-align:center}
.tlead{margin:0 0 32px;text-align:center;font-size:17px;line-height:26px;color:var(--muted)}
.tpage.on{padding-top:4px;padding-bottom:0}
.tpage.on h1,.tpage.on .tlead{display:none}
.tchat{position:relative;display:flex;flex-direction:column}
.tlog{display:none}
.tchat.on .tlog{display:flex;flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:16px 2px;flex-direction:column;gap:18px}
.tm{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}
.tm.u{align-self:flex-end;max-width:85%;padding:9px 14px;border-radius:16px 16px 4px 16px;background:var(--tile)}
.tm.a{align-self:flex-start;max-width:100%}
.tm.wait{color:var(--muted)}
.tm.wait::after{content:'';display:inline-block;width:1.2em;text-align:left;animation:tdots 1.2s steps(4,end) infinite}
@keyframes tdots{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}}
@media (prefers-reduced-motion:reduce){.tm.wait::after{animation:none;content:'…'}}
.tfoot{flex:0 0 auto}
.tform{display:flex;align-items:flex-end;gap:8px;margin:0;padding:8px 8px 8px 18px;border:1px solid var(--hairline);border-radius:22px;background:var(--card);box-shadow:0 1px 2px rgba(17,17,16,.04),0 10px 30px rgba(17,17,16,.05)}
.tform:focus-within{border-color:var(--underline)}
.tform textarea{flex:1;min-width:0;min-height:40px;max-height:140px;padding:8px 0;border:0;background:transparent;font:300 17px/24px var(--sans);color:var(--ink);resize:none}
.tform textarea:focus{outline:0}
.tform textarea::placeholder{color:var(--faint)}
.tbtn{flex:0 0 auto;display:grid;place-items:center;width:40px;height:40px;border-radius:20px;border:1px solid var(--hairline);background:transparent;color:var(--ink);cursor:pointer}
.tbtn[aria-expanded=true]{background:var(--tile)}
.tbtn[aria-expanded=true] svg,.tmore[aria-expanded=true] svg{transform:rotate(45deg)}
.tsend{border-color:var(--ink);background:var(--ink);color:var(--bg)}
.tsend:disabled{opacity:.35;cursor:default}
.tleft{margin:8px 18px 0;font-size:12px;line-height:18px;color:var(--faint)}
.tpaused{padding:4px 2px}
.tpaused p{margin:0}.tpaused .tpaused-links{margin-top:6px}
.tideas{margin:24px 0 0}
.tasks{list-style:none;margin:0;padding:0}
.tasks li{margin:0}
.tasks li+li{border-top:1px solid var(--hairline)}
.tasks button{display:block;width:100%;min-height:44px;padding:11px 18px;border:0;background:transparent;color:var(--muted);font:300 15px/22px var(--sans);text-align:left;cursor:pointer}
.tasks button:hover,.tasks button:focus-visible{color:var(--ink)}
.tmore{display:inline-flex;align-items:center;gap:6px;min-height:44px;margin:4px 0 0;padding:0 18px;border:0;background:transparent;color:var(--faint);font:400 14px var(--sans);cursor:pointer}
.tmore:hover{color:var(--ink)}
.tmore svg{width:14px;height:14px}
.ttopic{margin:20px 18px 2px;font-size:12px;line-height:18px;color:var(--faint)}
.tall .ttopic:first-child{margin-top:8px}
.tfeat+.tmore{margin-top:4px}
.tdrawer{position:absolute;z-index:2;left:0;right:0;bottom:calc(var(--tfoot,120px) + 8px);max-height:60%;overflow-y:auto;overscroll-behavior:contain;padding:4px 0 8px;border:1px solid var(--hairline);border-radius:16px;background:var(--card);box-shadow:0 10px 30px rgba(17,17,16,.08)}
.tdrawer .tideas{margin:0}
.tdrawer .tfeat,.tdrawer .tmore{display:none}
.tfine{margin:28px 18px 0;font-size:12px;line-height:18px;color:var(--faint)}
.tchat.on .tfine{margin:8px 18px 12px}
.tchat [hidden]{display:none}
.dsr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
@media (max-width:760px){
.tpage{padding-top:32px}
.tpage h1{font-size:40px;line-height:44px;margin-bottom:8px}
.tlead{font-size:16px;line-height:24px;margin-bottom:24px}
.tform{padding-left:14px}
.tasks button,.tleft,.tfine,.ttopic{padding-left:14px;padding-right:14px;margin-left:0;margin-right:0}
.tmore{padding:0 14px}
.tchat.on .tlog{padding:12px 0}
.tchat.on .tfine{margin:8px 0 12px}
}
</style>`

const list = (asks: string[]) => `<ul class="tasks">${asks.map((q) => `<li><button type="button">${esc(q)}</button></li>`).join('')}</ul>`

function ideas(): string {
  const all = TRY_IDEAS.map((g) => `<p class="ttopic">${esc(g.topic)}</p>${list(g.asks)}`).join('')
  return `<div class="tideas" aria-label="Example questions" role="group"><div class="tfeat">${list(TRY_FEATURED)}</div><button type="button" class="tmore" aria-controls="tall" aria-expanded="false">More questions ${PLUS}</button><div class="tall" id="tall" hidden>${all}</div></div>`
}

function body(): string {
  return `${CSS}<main class="tpage">
<h1>Try it</h1>
<p class="tlead">Ask about three made-up companies and a personal set. Demo data only, nothing real.</p>
<section class="tchat" aria-label="Demo chat">
<div class="tlog" role="log" aria-live="polite"></div>
<div class="tdrawer" id="tideas" hidden></div>
<div class="tfoot">
<div class="tpaused" hidden><p></p>${CONNECT}</div>
<form class="tform"><button type="button" class="tbtn tplus" aria-label="Example questions" aria-controls="tideas" aria-expanded="false" hidden>${PLUS}</button><label class="dsr" for="tq">Your question</label><textarea id="tq" rows="1" maxlength="1000" placeholder="Ask about the demo’s finances" enterkeyhint="send" required></textarea><button type="submit" class="tbtn tsend" aria-label="Send">${UP}</button></form>
<p class="tleft">${TRY_MAX_QUESTIONS} of ${TRY_MAX_QUESTIONS} questions left</p>
</div>
${ideas()}
<p class="tfine">Claude answers by reading the demo through the same Aggregate tools your own AI would use. Your question is sent to Anthropic to answer it. Aggregate doesn’t store your questions; it only counts them to keep the demo within its limits. Aggregate is free during beta.</p>
</section>
</main>
<script src="${TRY_JS_PATH}" defer></script>`
}

export function renderTryPage(fonts: LegalFonts): LegalPage {
  const md = '---\ntitle: Try it\ndescription: Ask an AI about a sample company’s finances through Aggregate. No sign-up; demo data only.\n---\n'
  return renderDoc(md, fonts, '/try', { body, bare: true })
}

export const TRY_JS = `(function(){
var chat=document.querySelector('.tchat');if(!chat)return;
var MAX=${TRY_MAX_QUESTIONS},PAUSED='Demo chat is paused — connect Aggregate to your own AI assistant or agent.';
var touch=window.matchMedia('(pointer:coarse)').matches,page=document.querySelector('.tpage'),log=chat.querySelector('.tlog'),drawer=chat.querySelector('.tdrawer'),foot=chat.querySelector('.tfoot'),form=chat.querySelector('.tform'),input=form.querySelector('textarea'),send=form.querySelector('.tsend'),plus=form.querySelector('.tplus'),left=chat.querySelector('.tleft'),paused=chat.querySelector('.tpaused'),tideas=chat.querySelector('.tideas'),all=tideas.querySelector('.tall'),feat=tideas.querySelector('.tfeat'),more=tideas.querySelector('.tmore'),msgs=[],busy=false,on=false;
var down=function(){log.scrollTop=log.scrollHeight};
var add=function(cls,text){var p=document.createElement('p');p.className='tm '+cls;p.textContent=text;log.appendChild(p);down();return p};
var count=function(){var n=MAX-msgs.length/2;left.textContent=n+' of '+MAX+' questions left'};
var grow=function(){input.style.height='auto';input.style.height=Math.min(input.scrollHeight,140)+'px';chat.style.setProperty('--tfoot',(chat.clientHeight-foot.offsetTop)+'px')};
var openIdeas=function(open){if(plus.hidden)return;drawer.hidden=!open;plus.setAttribute('aria-expanded',open?'true':'false')};
// Empty, the page is a title, the input and a few questions; the first question turns it into a chat that fills the screen.
var start=function(){if(on)return;on=true;page.classList.add('on');chat.classList.add('on');all.hidden=false;drawer.appendChild(tideas);plus.hidden=false;window.scrollTo(0,0);size()};
var stop=function(text){paused.querySelector('p').textContent=text;paused.hidden=false;form.hidden=true;left.hidden=true;openIdeas(false);grow()};
var ask=function(q){q=q.trim();if(!q||busy)return;start();
openIdeas(false);add('u',q);var wait=add('a wait','Reading the demo’s books');
busy=true;send.disabled=true;input.value='';grow();var next=msgs.concat([{role:'user',content:q}]);
fetch('/api/try',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:next})}).then(function(r){return r.json()}).then(function(j){
if(j.answer){msgs=next.concat([{role:'assistant',content:j.answer}]);wait.className='tm a';wait.textContent=j.answer;count();down();
if(msgs.length>=MAX*2){stop('That’s '+MAX+' questions for this chat. Reload the page to start over, or connect Aggregate to your own AI assistant or agent.')}}
else{log.removeChild(wait);stop(j.message||PAUSED)}
}).catch(function(){log.removeChild(wait);stop(PAUSED)}).finally(function(){busy=false;send.disabled=false;if(!form.hidden&&!touch)input.focus({preventScroll:true})})};
tideas.addEventListener('click',function(e){var b=e.target.closest('.tasks button');if(b)ask(b.textContent)});
more.addEventListener('click',function(){var open=all.hidden;all.hidden=!open;feat.hidden=open;more.setAttribute('aria-expanded',open?'true':'false')});
plus.addEventListener('click',function(){openIdeas(drawer.hidden)});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!drawer.hidden){openIdeas(false);plus.focus()}});
form.addEventListener('submit',function(e){e.preventDefault();ask(input.value)});
input.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();ask(input.value)}});
input.addEventListener('input',grow);
// Phones: keep the chat inside what the keyboard leaves, so the input never hides behind it.
var vv=window.visualViewport,narrow=window.matchMedia('(max-width:760px)');
// The chat fills what's left of the screen below its top, so the input shows without scrolling.
var size=function(){if(!on){grow();return}chat.style.minHeight='';var top=chat.getBoundingClientRect().top+window.scrollY,h=window.innerHeight-top;chat.style.height=Math.max(narrow.matches?320:400,h)+'px';grow()};
// Only an open keyboard (the visible area well short of the window) shrinks the chat; a focus alone doesn't.
var fit=function(){if(!on||!vv||!narrow.matches||document.activeElement!==input||vv.height>window.innerHeight-120){size();return}
// Bring the chat's top near the top of what's visible, then end it at the visible bottom, so the input shows
// whether or not the browser pans to it.
// A shorter chat can shorten the page and pull the scroll back, so it's placed again once that has settled.
var place=function(){chat.style.minHeight='0';chat.style.height=Math.max(200,vv.offsetTop+vv.height-chat.getBoundingClientRect().top-8)+'px';grow();down()};
window.scrollBy(0,chat.getBoundingClientRect().top-vv.offsetTop-8);place();requestAnimationFrame(place)};
window.addEventListener('resize',fit);if(vv){vv.addEventListener('resize',fit);input.addEventListener('focus',function(){setTimeout(fit,50)});input.addEventListener('blur',function(){setTimeout(fit,50)})}
size();count();
})();`
