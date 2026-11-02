// "Find your institution" on the connectors page: names from Plaid's public coverage file, nothing else.
// To remove it: delete this file and docs/institutions.json, its COPY line in Dockerfile, and its uses in docs-shell.ts, legal.ts and app.ts.
import { readFileSync } from 'node:fs'

export const INSTITUTIONS_PATH = '/assets/institutions.json'

export interface InstitutionList {
  generated: string
  names: string[]
}

export function loadInstitutions(file: URL = new URL('../../../docs/institutions.json', import.meta.url)): InstitutionList | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as InstitutionList
  } catch {
    console.warn('[agfn] docs/institutions.json is missing: the connectors page has no institution search')
    return null
  }
}

export function institutionsBody(list: InstitutionList | null): string {
  if (!list) return ''
  const count = (Math.floor(list.names.length / 100) * 100).toLocaleString('en-US')
  const updated = new Date(`${list.generated}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  return `<section class="dinst" data-institutions>
<h2 id="find-your-institution">Find your institution</h2>
<p>Banks, credit unions, brokerages, lenders and more: search over ${count} US institutions supported by Plaid.</p>
<label class="dinst-q"><span class="dsr">Institution name</span><input type="search" placeholder="Institution name" autocomplete="off" spellcheck="false"></label>
<p class="dinst-n" role="status"></p>
<ul class="dinst-list"></ul>
<p class="dfine">From Plaid’s public coverage file, updated ${updated}. Listed means supported by Plaid, not that a given account will connect, and availability can change. Being listed doesn’t mean an institution endorses Aggregate.</p>
</section>`
}

export const INSTITUTIONS_CSS = `
.dinst{margin-bottom:36px}
.dinst h2{margin:0 0 6px;font-size:22px;line-height:28px}
.dinst-q{display:block;margin:12px 0 8px}
.dinst-q input{width:100%;box-sizing:border-box;height:44px;padding:0 14px;border:1px solid var(--hairline);border-radius:10px;background:transparent;font:inherit;font-size:16px;color:var(--ink)}
.dinst-q input:focus{outline:0;border-color:var(--ink)}
.dinst-n{margin:0 0 4px;font-size:14px;line-height:21px;color:var(--muted);min-height:21px}
.dmain .dinst-list{list-style:none;margin:0 0 12px;padding:0}
.dmain .dinst-list li{margin:0;padding:10px 0;border-bottom:1px solid var(--hairline);font-size:15px;overflow-wrap:anywhere}
.dsr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
`

export const INSTITUTIONS_JS = `(function(){
var box=document.querySelector('[data-institutions]');if(!box)return;
var input=box.querySelector('input'),say=box.querySelector('.dinst-n'),list=box.querySelector('.dinst-list'),names=null,MAX=20;
var load=function(){if(names)return Promise.resolve(names);return fetch('${INSTITUTIONS_PATH}').then(function(r){return r.json()}).then(function(j){return names=j.names})};
var show=function(){var q=input.value.trim().toLowerCase();while(list.firstChild)list.removeChild(list.firstChild);say.textContent='';if(q.length<2)return;
load().then(function(all){if(input.value.trim().toLowerCase()!==q)return;
var hits=all.filter(function(n){return n.toLowerCase().indexOf(q)>=0}),starts=hits.filter(function(n){return n.toLowerCase().indexOf(q)===0}),rest=hits.filter(function(n){return n.toLowerCase().indexOf(q)!==0});
starts.concat(rest).slice(0,MAX).forEach(function(n){var li=document.createElement('li');li.textContent=n;list.appendChild(li)});
say.textContent=!hits.length?'Not on the list. You can still upload statements.':hits.length>MAX?'First '+MAX+' of '+hits.length+'. Keep typing to narrow it.':hits.length===1?'1 match.':hits.length+' matches.'}).catch(function(){say.textContent='The list didn’t load. Try again.'})};
input.addEventListener('input',show);
})();`
