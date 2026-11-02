// The public docs' frame: header with search, a sidebar of groups that open and close, and the docs home and connections
// pages. Pages come from legal.ts (the markdown) and app.ts (the routes); on docs.aggregate.finance docs-host.ts rewrites
// the /docs links. The CSP allows no inline script, so behavior lives in DOCS_JS, served at DOCS_JS_PATH.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { INSTITUTIONS_CSS } from './docs-institutions.ts'

export const DOCS_JS_PATH = '/assets/docs.js'
export const DOCS_SEARCH_PATH = '/assets/docs-search.json'
/** Where the self-hosting doc lives: it isn't one of the served pages. */
const SELF_HOSTING = 'https://github.com/Izzy-Gottz/aggregate-finance/blob/main/docs/self-hosting.md'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const DOCS_NAV: Array<{ name: string; items: Array<{ label: string; href: string }> }> = [
  {
    name: 'Get started',
    items: [
      { label: 'Get started', href: '/docs' },
      { label: 'What it connects', href: '/docs/connectors' },
      { label: 'Connect all your finances to AI', href: '/docs/guides/connect-all-your-finances-to-ai' },
      { label: 'All guides', href: '/docs/guides' },
    ],
  },
  {
    name: 'Connect your AI',
    items: [
      { label: 'Claude', href: '/docs/guides/connect-claude' },
      { label: 'ChatGPT', href: '/docs/guides/connect-chatgpt' },
      { label: 'Claude Code', href: '/docs/guides/connect-cli' },
      { label: 'Cursor and VS Code', href: '/docs/guides/connect-cursor' },
      { label: 'Perplexity', href: '/docs/guides/connect-perplexity' },
      { label: 'Other apps', href: '/docs/connect-your-ai' },
      { label: 'Bank, Stripe and QuickBooks to Claude', href: '/docs/guides/connect-finances-to-claude' },
      { label: 'Bank, Stripe and QuickBooks to ChatGPT', href: '/docs/guides/connect-finances-to-chatgpt' },
    ],
  },
  {
    name: 'Use it',
    items: [
      { label: 'Prompt recipes', href: '/docs/recipes' },
      { label: 'AI CFO for startups', href: '/docs/guides/ai-cfo-for-startups' },
      { label: 'Best finance MCP servers', href: '/docs/guides/best-finance-mcp-server' },
      { label: 'How we count cash, burn and runway', href: '/docs/guides/definitions' },
      { label: 'What it can’t do yet', href: '/docs/guides/limits' },
    ],
  },
  {
    name: 'Reference',
    items: [
      { label: 'REST API', href: '/docs/api' },
      { label: 'Self-hosting', href: SELF_HOSTING },
    ],
  },
  {
    name: 'Trust',
    items: [
      { label: 'Security', href: '/security' },
      { label: 'Privacy', href: '/privacy' },
      { label: 'Terms', href: '/terms' },
    ],
  },
]

const MARK = (size: number) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" aria-hidden="true"><path d="M50 12V88M50 12 33 88M50 12 67 88M50 12 16 88M50 12 84 88"/></svg>`
const SEARCH_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>'
const MENU_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 8h16M4 16h16"/></svg>'

export const DOCS_CSS = `
:root{--bg:#FCFCFB;--ink:#111110;--muted:#5F5E5A;--faint:#74736E;--hairline:#EEEDEA;--underline:#D5D4D0;--tile:#F3F2EF;--card:#FFFFFF;--live:#2F5D3A;--live-rule:#BFD3C3;--serif:'Newsreader',Georgia,'Times New Roman',serif;--sans:'Geist',ui-sans-serif,system-ui,sans-serif;--mono:ui-monospace,'SF Mono',Menlo,monospace;color-scheme:light}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink)}
body{font:300 16px/26px var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:inherit;text-decoration-color:var(--underline);text-underline-offset:3px}
a:hover{text-decoration-color:var(--ink)}
.dtop{display:flex;align-items:center;gap:24px;padding:18px 32px;border-bottom:1px solid var(--hairline)}
.dhome{display:flex;align-items:center;gap:12px;text-decoration:none;font-size:22px;line-height:28px}
.dhome b{font-weight:500;letter-spacing:-.01em}
.dhome span{color:var(--muted)}
.dsearch{position:relative;flex:1 1 240px;max-width:420px;margin:0 auto}
.dsearch label{display:flex;align-items:center;gap:10px;height:40px;padding:0 14px;border:1px solid var(--hairline);border-radius:10px;background:var(--card);color:var(--muted);font-size:14px}
.dsearch input{flex:1;min-width:0;border:0;outline:0;background:transparent;font:inherit;color:var(--ink)}
.dsearch label:focus-within{border-color:var(--ink)}
.dsearch kbd{font:12px var(--sans);color:var(--faint);border:1px solid var(--hairline);border-radius:5px;padding:1px 6px}
.dresults{position:absolute;z-index:5;top:46px;left:0;right:0;margin:0;padding:6px;list-style:none;background:var(--card);border:1px solid var(--hairline);border-radius:10px;max-height:60vh;overflow:auto}
.dresults[hidden]{display:none}
.dresults a{display:block;padding:8px 10px;border-radius:7px;text-decoration:none;font-size:14px;line-height:20px}
.dresults a:hover,.dresults a:focus{background:var(--tile);outline:0}
.dresults small{display:block;color:var(--muted);font-size:13px}
.dresults li.none{padding:8px 10px;font-size:14px;color:var(--muted)}
.dlinks{display:flex;gap:20px;font-size:14px;white-space:nowrap}
.dlinks a{text-decoration:none;color:var(--muted);padding:10px 0}
.dlinks a:last-child{color:var(--ink)}
.dicon{display:none;width:44px;height:44px;border:0;background:none;color:var(--ink);align-items:center;justify-content:center;padding:0;cursor:pointer}
.dwrap{display:flex;max-width:1200px;margin:0 auto}
.dnav{flex:0 0 260px;padding:32px 24px 48px 32px;font-size:14px;line-height:20px}
.dnav details{margin-bottom:22px}
.dnav summary{display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-weight:500;cursor:pointer;list-style:none}
.dnav summary::-webkit-details-marker{display:none}
.dnav summary::after{content:'+';color:var(--faint);font-weight:300}
.dnav details[open] summary::after{content:'−'}
.dnav a{display:block;padding:5px 0 5px 12px;border-left:1px solid var(--hairline);color:var(--muted);text-decoration:none}
.dnav a:hover{color:var(--ink)}
.dnav a[aria-current]{border-left-color:var(--ink);color:var(--ink)}
.dmain{flex:1 1 auto;min-width:0;max-width:760px;padding:40px 40px 96px}
.dmain.wide{max-width:880px}
.dcrumb{font-size:13px;line-height:20px;color:var(--faint);margin-bottom:12px}
.dmain h1{font:300 40px/46px var(--serif);letter-spacing:-.015em;margin:0 0 10px}
.dmain h1+p{font-size:17px;line-height:27px;color:var(--muted);margin:0 0 28px}
.dmain h2{font:400 24px/30px var(--serif);margin:40px 0 10px}
.dmain h3{font:400 16px/24px var(--sans);margin:24px 0 4px}
.dmain p,.dmain ul,.dmain ol,.dmain table{margin:0 0 16px}
.dmain strong{font-weight:500}
.dmain ul{padding-left:20px}
.dmain li{margin:4px 0}
.dmain>ol:not(.dsteps){list-style:none;padding:0;counter-reset:step}
.dmain>ol:not(.dsteps)>li{position:relative;counter-increment:step;padding:0 0 14px 46px;margin:0}
.dmain>ol:not(.dsteps)>li::before{content:counter(step);position:absolute;left:0;top:-1px;width:28px;height:28px;border:1px solid var(--underline);border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:400}
.dmain code{font:14px var(--mono)}
.dmain pre{position:relative;background:var(--card);border:1px solid var(--hairline);border-radius:12px;padding:14px 72px 14px 16px;margin:8px 0 16px;overflow-x:auto}
.dcopy{height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--ink);background:var(--ink);color:var(--bg);font:400 14px var(--sans);cursor:pointer}
.dmain pre .dcopy{position:absolute;top:8px;right:8px;height:32px;padding:0 12px;font-size:13px}
.dmain blockquote{margin:0 0 16px;padding:14px 18px;border-radius:12px;background:var(--tile);color:var(--muted)}
.dmain blockquote p:last-child{margin:0}
.dmain table{display:block;overflow-x:auto;border-collapse:collapse;font-size:14px;line-height:21px}
.dmain th,.dmain td{text-align:left;padding:8px 12px 8px 0;border-bottom:1px solid var(--hairline);vertical-align:top}
.dmain th{font-weight:400;color:var(--muted)}
.dpager{display:flex;justify-content:space-between;gap:16px;margin-top:40px;font-size:14px}
.dpager a{text-decoration:none;color:var(--muted)}
.dpager a:last-child{color:var(--ink)}
.dsteps{list-style:none;margin:0 0 32px!important;padding:0;border-top:1px solid var(--hairline)}
.dsteps li{display:flex;gap:20px;padding:18px 0;margin:0;border-bottom:1px solid var(--hairline)}
.dsteps i{font:400 22px/26px var(--serif);color:var(--faint);width:20px}
.dsteps div{flex:1;min-width:0}
.dsteps b{display:block;font-weight:400}
.dsteps span{display:block;font-size:14px;line-height:21px;color:var(--muted)}
.dsteps a{align-self:center;font-size:14px;color:var(--muted);white-space:nowrap;padding:10px 0}
.dlink{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin:0 0 40px;padding:16px 18px;border:1px solid var(--hairline);border-radius:12px;background:var(--card)}
.dlink div{flex:1 1 240px;min-width:0}
.dlink small{display:block;font-size:13px;line-height:20px;color:var(--muted)}
.dlink code{display:block;overflow-wrap:anywhere}
.dais{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:40px}
.dais a{display:flex;justify-content:space-between;padding:12px 16px;border:1px solid var(--hairline);border-radius:10px;background:var(--card);text-decoration:none;font-weight:400;font-size:15px}
.dais a::after{content:'→';color:var(--faint)}
.dnext{border-top:1px solid var(--hairline)}
.dnext a{display:flex;gap:16px;padding:14px 0;border-bottom:1px solid var(--hairline);text-decoration:none}
.dnext b{flex:0 0 220px;font-weight:400;font-size:15px}
.dnext span{flex:1;font-size:14px;color:var(--muted)}
.dchips{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 28px}
.dchips button{height:36px;padding:0 14px;border-radius:18px;border:1px solid var(--hairline);background:var(--card);color:var(--muted);font:400 14px var(--sans);cursor:pointer}
.dchips button[aria-pressed=true]{background:var(--ink);border-color:var(--ink);color:var(--bg)}
.dupdated{margin:-8px 0 20px;font-size:14px;line-height:21px;color:var(--muted)}
.dcat{margin-bottom:36px}
.dcat[hidden]{display:none}
.dcat h2{margin:0 0 6px;font-size:22px;line-height:28px}
.drows{border-top:1px solid var(--hairline)}
.drow{display:flex;align-items:center;gap:16px;padding:14px 0;border-bottom:1px solid var(--hairline);text-decoration:none}
.dtile{flex:0 0 32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:var(--tile);font-size:13px;font-weight:500;color:var(--muted)}
.dtile.brand{background:#FFFFFF;border:1px solid var(--hairline)}
.dtile img{width:20px;height:20px;object-fit:contain}
.drow b{flex:0 0 170px;font-size:15px;font-weight:400}
.drow span.what{flex:1;min-width:0;font-size:14px;line-height:21px;color:var(--muted)}
.dtag{font-size:12px;line-height:18px;color:var(--muted);border:1px solid var(--hairline);border-radius:10px;padding:1px 8px}
.dtag.live{color:var(--live);border-color:var(--live-rule)}
.drow i{font-style:normal;color:var(--faint);width:14px}
.dfine{font-size:12px;line-height:18px;color:var(--faint)}
@media (max-width:760px){
.dtop{justify-content:space-between;gap:4px;padding:8px 8px 8px 16px;flex-wrap:wrap}
.dhome{font-size:19px;gap:10px}
.dicon{display:flex}
.dtopend{display:flex;margin-left:auto}
.dlinks{display:none}
.dsearch{display:none;flex:1 1 100%;max-width:none;order:3;padding:0 8px 8px 0}
.dsearch.open{display:block}
.dsearch kbd{display:none}
.dresults{right:8px}
.dwrap{display:block}
.dnav{display:none;padding:16px;border-bottom:1px solid var(--hairline)}
.dnav.open{display:block}
.dnav .mobile-links{display:block}
.dmain{padding:28px 16px 64px}
.dmain h1{font-size:34px;line-height:40px}
.dmain h1+p{font-size:16px;line-height:25px}
.dais{grid-template-columns:minmax(0,1fr)}
.dnext a{display:block}
.dnext b,.dnext span{display:block}
.dsteps li{gap:14px;flex-wrap:wrap}
.drow{flex-wrap:wrap;gap:6px 12px}
.drow b{flex:1 1 auto}
.drow span.what{order:5;flex:1 1 100%;padding-left:44px}
}
@media (min-width:761px){.dtopend .dicon{display:none}.dnav .mobile-links{display:none}}
`

/** Menu, search, chips and Copy. Every page reads and works without it; only these extras need it. */
export const DOCS_JS = `(function(){
var $=function(s,r){return (r||document).querySelector(s)},$$=function(s,r){return [].slice.call((r||document).querySelectorAll(s))};
var menu=$('[data-menu]'),nav=$('.dnav');
if(menu&&nav)menu.addEventListener('click',function(){var o=nav.classList.toggle('open');menu.setAttribute('aria-expanded',String(o))});
var box=$('.dsearch'),input=$('.dsearch input'),list=$('.dresults'),open=$('[data-search]'),pages=null;
if(open&&box)open.addEventListener('click',function(){var o=box.classList.toggle('open');open.setAttribute('aria-expanded',String(o));if(o)input.focus()});
// On the docs host paths have no /docs, and the page's own address says which host this is.
var here=function(p){return location.pathname.indexOf('/docs')===0||p.indexOf('/docs')!==0?p:(p.replace(/^\\/docs/,'')||'/')};
var load=function(){if(pages)return Promise.resolve(pages);return fetch('${DOCS_SEARCH_PATH}').then(function(r){return r.json()}).then(function(j){return pages=j})};
var clear=function(){while(list.firstChild)list.removeChild(list.firstChild)};
var show=function(q){
  clear();list.hidden=!q;if(!q)return;
  load().then(function(all){
    var w=q.toLowerCase(),hits=[];
    all.forEach(function(p){
      if(p.title.toLowerCase().indexOf(w)>=0)hits.push({t:p.title,u:p.path,r:0});
      p.headings.forEach(function(h){if(h.text.toLowerCase().indexOf(w)>=0)hits.push({t:h.text,s:p.title,u:p.path+'#'+h.id,r:1})});
    });
    hits.sort(function(a,b){return a.r-b.r});clear();
    hits.slice(0,12).forEach(function(h){
      var li=document.createElement('li'),a=document.createElement('a');a.href=here(h.u);a.textContent=h.t;
      if(h.s){var s=document.createElement('small');s.textContent=h.s;a.appendChild(s)}
      li.appendChild(a);list.appendChild(li)});
    if(!hits.length){var li=document.createElement('li');li.className='none';li.textContent='Nothing found';list.appendChild(li)}
  }).catch(function(){list.hidden=true});
};
if(input){
  input.addEventListener('input',function(){show(input.value.trim())});
  input.addEventListener('keydown',function(e){
    if(e.key==='Escape'){input.value='';show('');input.blur()}
    if(e.key==='ArrowDown'||e.key==='Enter'){var a=$('a',list);if(a){e.preventDefault();a.focus()}}});
  list.addEventListener('keydown',function(e){
    var as=$$('a',list),i=as.indexOf(document.activeElement);
    if(e.key==='ArrowDown'&&as[i+1]){e.preventDefault();as[i+1].focus()}
    if(e.key==='ArrowUp'){e.preventDefault();(as[i-1]||input).focus()}
    if(e.key==='Escape'){input.focus()}});
  document.addEventListener('keydown',function(e){
    var t=e.target.tagName;if(e.key==='/'&&t!=='INPUT'&&t!=='TEXTAREA'){e.preventDefault();if(box.classList)box.classList.add('open');input.focus()}});
  document.addEventListener('click',function(e){if(!box.contains(e.target))list.hidden=true});
}
var copy=function(b,get){b.addEventListener('click',function(){navigator.clipboard.writeText(get()).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1500)})})};
$$('[data-copy]').forEach(function(b){copy(b,function(){return b.dataset.copy})});
$$('.dmain pre').forEach(function(p){var b=document.createElement('button');b.type='button';b.className='dcopy';b.textContent='Copy';var t=p.textContent;p.appendChild(b);copy(b,function(){return t})});
var chips=$$('.dchips button'),cats=$$('.dcat');
chips.forEach(function(c){c.addEventListener('click',function(){
  chips.forEach(function(x){x.setAttribute('aria-pressed',String(x===c))});
  cats.forEach(function(s){s.hidden=!!c.dataset.cat&&s.dataset.cat!==c.dataset.cat})})});
})();
`

function sidebar(path: string): string {
  const groups = DOCS_NAV.map((g) => {
    const open = path === '/docs' || g.items.some((i) => i.href === path) || (g.name === 'Connect your AI' && path.startsWith('/docs/guides/connect-'))
    return `<details${open ? ' open' : ''}><summary>${g.name}</summary>${g.items.map((i) => `<a href="${esc(i.href)}"${i.href === path ? ' aria-current="page"' : ''}>${i.label}</a>`).join('')}</details>`
  })
  return `<nav class="dnav" aria-label="Docs">${groups.join('')}<div class="mobile-links"><a href="https://aggregate.finance">aggregate.finance</a><a href="%AGFN_BASE_URL%/">Sign in</a></div></nav>`
}

/** Next and back within the sidebar's own pages; the two outside pages (legal, GitHub) aren't steps. */
function pager(path: string): string {
  const flat = DOCS_NAV.flatMap((g) => g.items).filter((i) => i.href.startsWith('/docs'))
  const at = flat.findIndex((i) => i.href === path)
  if (at < 0) return ''
  const [back, next] = [flat[at - 1], flat[at + 1]]
  return `<div class="dpager">${back ? `<a href="${esc(back.href)}">← ${back.label}</a>` : '<span></span>'}${next ? `<a href="${esc(next.href)}">${next.label} →</a>` : ''}</div>`
}

const crumbOf = (path: string): string | undefined =>
  DOCS_NAV.find((g) => g.items.some((i) => i.href === path))?.name ?? (path.startsWith('/docs/guides/connect-') ? 'Connect your AI' : path.startsWith('/docs/guides/') ? 'Guides' : undefined)

/** A whole docs page. `head` is the page's own title, meta and font tags. */
export function docsPage(o: { path: string; head: string; body: string; wide?: boolean }): string {
  const crumb = o.path === '/docs' ? undefined : crumbOf(o.path)
  return `<!doctype html>
<html lang="en"><head>${o.head}<style>${DOCS_CSS}${INSTITUTIONS_CSS}</style><script src="${DOCS_JS_PATH}" defer></script></head>
<body>
<header class="dtop">
<a class="dhome" href="/docs">${MARK(34)}<b>Aggregate</b><span>Docs</span></a>
<div class="dsearch"><label>${SEARCH_ICON}<input type="search" placeholder="Search the docs" aria-label="Search the docs" autocomplete="off"><kbd>/</kbd></label><ul class="dresults" hidden></ul></div>
<div class="dlinks"><a href="https://aggregate.finance">aggregate.finance</a><a href="%AGFN_BASE_URL%/">Sign in</a></div>
<div class="dtopend"><button type="button" class="dicon" data-search aria-label="Search" aria-expanded="false">${SEARCH_ICON}</button><button type="button" class="dicon" data-menu aria-label="Menu" aria-expanded="false">${MENU_ICON}</button></div>
</header>
<div class="dwrap">${sidebar(o.path)}<main class="dmain${o.wide ? ' wide' : ''}">
${crumb ? `<div class="dcrumb">${crumb}</div>` : ''}${o.body}
${pager(o.path)}
</main></div>
</body></html>`
}

const LINK = 'https://app.aggregate.finance/mcp'

/** The docs home: where to start, in three steps. */
export function docsHomeBody(): string {
  const step = (n: number, title: string, line: string, href: string, label: string) =>
    `<li><i>${n}</i><div><b>${title}</b><span>${line}</span></div><a href="${href}">${label} →</a></li>`
  const ais = [['Claude', 'connect-claude'], ['ChatGPT', 'connect-chatgpt'], ['Claude Code', 'connect-cli'], ['Cursor and VS Code', 'connect-cursor'], ['Perplexity', 'connect-perplexity']]
  const next = [
    ['Prompt recipes', 'Questions worth asking first, ready to paste.', '/docs/recipes'],
    ['How we count', 'What cash, burn, runway and MRR mean here, and where each number comes from.', '/docs/guides/definitions'],
    ['What it can’t do yet', 'Known limits, stated plainly, and what happens instead.', '/docs/guides/limits'],
    ['Security', 'Read-only access, encryption, and how to revoke anything.', '/security'],
  ]
  return `<h1>Get started</h1>
<p>Connect your accounts, then connect the AI you already use. Three steps, about five minutes. Aggregate only reads; it can’t move money.</p>
<ol class="dsteps">
${step(1, 'Create your workspace', 'Sign up with a passkey, Google or a one-time email code. No passwords.', '%AGFN_BASE_URL%/?start=1', 'Sign up')}
${step(2, 'Connect your accounts', '9,600+ US institutions through Plaid, plus Stripe, QuickBooks, Shopify and 15 more apps.', '/docs/connectors', 'See all 18')}
${step(3, 'Connect your AI', 'Paste one link into Claude, ChatGPT or any app that supports MCP, then choose what it can see.', '/docs/connect-your-ai', 'How')}
</ol>
<div class="dlink"><div><small>Your Aggregate link</small><code>${LINK}</code></div><button type="button" class="dcopy" data-copy="${LINK}">Copy</button></div>
<h2>Connect your AI</h2>
<div class="dais">${ais.map(([n, s]) => `<a href="/docs/guides/${s}">${n}</a>`).join('')}<a href="/docs/connect-your-ai">Other apps</a></div>
<h2>Good to read next</h2>
<div class="dnext">${next.map(([t, d, h]) => `<a href="${h}"><b>${t}</b><span>${d}</span></a>`).join('')}</div>`
}

/** Files in the web build's brand folder (apps/web/scripts/build.mjs copies them), per ui/brand/README.md. Nothing else gets an icon. */
const BRAND_FILES: Record<string, [file: string, type: string]> = {
  Plaid: ['plaid/plaid-icon.png', 'image/png'],
  Mercury: ['mercury/mercury-icon.png', 'image/png'],
  'SimpleFIN Bridge': ['simplefin/simplefin-logo.svg', 'image/svg+xml'],
  Ramp: ['ramp/ramp-icon.png', 'image/png'],
  Shopify: ['shopify/shopify-bag-monotone-black.svg', 'image/svg+xml'],
  Square: ['square/square-icon.png', 'image/png'],
  Deel: ['deel/deel-icon.png', 'image/png'],
}

/** Name → data URL. One read at boot; the CSP allows data: images and the docs host serves no other asset path. */
export function loadDocsIcons(webDist: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, [file, type]] of Object.entries(BRAND_FILES)) {
    try {
      out[name] = `data:${type};base64,${readFileSync(join(webDist, 'brand', file)).toString('base64')}`
    } catch {
      // No build here (a test, say): the letter tile stands in.
    }
  }
  return out
}

/** Rows with a page of their own. */
const GUIDE_OF: Record<string, string> = {
  Plaid: 'connect-bank-accounts-to-claude',
  Stripe: 'connect-stripe-to-claude',
  Shopify: 'connect-shopify-to-chatgpt',
  Square: 'connect-square-to-claude',
  'QuickBooks Online': 'connect-quickbooks-to-claude',
  Deel: 'connect-deel-to-claude',
}
/** Rows of connectors.md that are features of Aggregate, not hosted connections. */
const NOT_A_CONNECTION = new Set(['Any payroll provider', 'Cap table'])
const CHIP: Record<string, string> = { 'Investments and equity': 'Investments' }

export interface Connection { name: string; what: string; tag: 'Live' | 'Beta' }

/** The hosted connections in connectors.md, by section: its Live and Beta rows. Limited ones (Xero) never list here. */
export function hostedConnections(md: string): Array<{ name: string; rows: Connection[] }> {
  const out: Array<{ name: string; rows: Connection[] }> = []
  for (const part of md.split(/^## /m).slice(1)) {
    const name = part.slice(0, part.indexOf('\n')).trim()
    if (name === 'Everything else') continue
    const rows: Connection[] = []
    for (const line of part.split('\n')) {
      const c = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(Live|Beta)\s*\|$/.exec(line)
      if (c && !NOT_A_CONNECTION.has(c[1]!)) rows.push({ name: c[1]!, what: c[2]!, tag: c[3] as Connection['tag'] })
    }
    if (rows.length) out.push({ name: CHIP[name] ?? name, rows })
  }
  return out
}

/** connectors.md as the page "See all" opens: its intro, the connections as rows with filters, and what follows them. */
export function connectionsBody(md: string, render: (md: string) => string, icons: Record<string, string>, institutions = ''): string {
  const sections = hostedConnections(md)
  const intro = md.slice(0, md.indexOf('\n## '))
  const rest = md.slice(md.indexOf('## Everything else'))
  const tile = (name: string) => (icons[name] ? `<span class="dtile brand"><img src="${icons[name]}" alt=""></span>` : `<span class="dtile" aria-hidden="true">${esc(name[0]!)}</span>`)
  const row = (r: Connection) => {
    const guide = GUIDE_OF[r.name]
    const inner = `${tile(r.name)}<b>${esc(r.name)}</b><span class="what">${esc(r.what)}</span><span class="dtag${r.tag === 'Live' ? ' live' : ''}">${r.tag}</span><i aria-hidden="true">${guide ? '→' : ''}</i>`
    return guide ? `<a class="drow" href="/docs/guides/${guide}">${inner}</a>` : `<div class="drow">${inner}</div>`
  }
  return `${render(intro)}
<div class="dchips" role="group" aria-label="Filter"><button type="button" aria-pressed="true">All</button>${sections.map((s) => `<button type="button" aria-pressed="false" data-cat="${esc(s.name)}">${esc(s.name)}</button>`).join('')}</div>
${sections.map((s) => `<section class="dcat" data-cat="${esc(s.name)}"><h2>${esc(s.name)}</h2><div class="drows">${s.rows.map(row).join('')}</div></section>`).join('\n')}
${institutions}
${render(rest)}
<p>Running your own server? <a href="${SELF_HOSTING}">Self-hosting adds PayPal, Lemon Squeezy, Expensify and more.</a></p>
<p class="dfine">Logos belong to their owners and are shown only to identify services you can connect. No endorsement implied. Brands whose terms need written permission show a letter instead.</p>`
}

/** What search looks through: titles and section headings, nothing from any workspace. */
export function docsSearchIndex(pages: Array<{ path: string; title: string; html: string }>): Array<{ path: string; title: string; headings: Array<{ id: string; text: string }> }> {
  return pages.map((p) => ({
    path: p.path,
    title: p.title,
    headings: [...p.html.matchAll(/<h2 id="([^"]+)">(.*?)<\/h2>/g)].map((m) => ({ id: m[1]!, text: m[2]!.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&') })),
  }))
}
