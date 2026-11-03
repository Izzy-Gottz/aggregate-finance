// "Banks and institutions" on the connectors page and the connect screen: names from Plaid's public coverage file, and a flag per name for its groups.
// To remove it: delete this file and docs/institutions.json, its COPY line in Dockerfile, and its uses in docs-shell.ts, legal.ts and app.ts.
import { readFileSync } from 'node:fs'

export const INSTITUTIONS_PATH = '/assets/institutions.json'

export interface InstitutionList {
  generated: string
  names: string[]
  /** One hex digit per name (scripts/institution-names.py): the INSTITUTION_GROUPS bits from Plaid's product columns. */
  flags: string
}

/** Groups from Plaid's coverage columns (Yisrael, 2026-11-03). Cards and loans share one column, so one group. */
// `lead` (34, 2026-11-03) only orders a group: names it matches come first, A–Z within each tier. Membership is still
// Plaid's column alone. `notLead` keeps credit unions and savings-and-loans out of the first tier. `top` (34, 2026-11-03)
// goes before both, in its own order: well-known names, each exactly as it appears in Plaid's file and in that group
// (docs-institutions.test.ts checks). A name Plaid doesn't list isn't added.
export const INSTITUTION_GROUPS: Array<{ bit: number; label: string; top?: string[]; lead?: string; notLead?: string }> = [
  {
    bit: 1,
    label: 'Banks and credit unions',
    top: ['Chase', 'Bank of America', 'Wells Fargo', 'Citibank Online', 'Capital One', 'U.S. Bank', 'PNC', 'TD Bank', 'Truist', 'Navy Federal Credit Union', 'USAA', 'Ally Bank', 'Citizens Bank', 'Fifth Third Bank', 'Regions Bank', 'M&T Bank', 'Huntington Bank - Personal & Business', 'Charles Schwab', 'SoFi', 'Chime'],
  },
  {
    bit: 2,
    label: 'Brokerages and retirement',
    // J.P. Morgan's self-directed investing signs in through Chase, which is how Plaid lists it. No Ally Invest in this group.
    top: ['Fidelity', 'Charles Schwab', 'Vanguard', 'Robinhood', 'E*TRADE from Morgan Stanley', 'Morgan Stanley', 'Merrill', 'Chase', 'Interactive Brokers - US', 'Wealthfront', 'Betterment', 'SoFi', 'Public', 'Webull', 'Empower Retirement', 'Principal Financial Group - Participant Logon', 'TIAA', 'John Hancock - Retirement Plan Services', 'Acorns', 'Stash'],
    lead: String.raw`securities|brokerage|invest|\bwealth\b|retire|401|\bira\b|fidelity|vanguard|schwab|robinhood|e\*?trade|merrill|edward jones|morgan stanley|tiaa|empower|betterment|wealthfront|acorns|webull|ameritrade|voya|prudential|annuit|pension|stocks`,
  },
  {
    bit: 4,
    label: 'Loans, mortgages and cards',
    lead: String.raw`\bcards?\b|\bloans?\b|lending|\blender|mortgage|servicing|capital one|american express|amex|\bdiscover\b|synchrony|sallie mae|navient|nelnet|mohela|affirm|auto financ|home financ`,
    notLead: String.raw`credit union|savings (and|&) loan`,
  },
  { bit: 8, label: 'Crypto exchanges' },
]

/** Search order: names starting with the query first; inside that, the group's top names (in their order), then its lead names, then the rest, A–Z. */
export function orderHits(hits: string[], query: string, group?: { top?: string[]; lead?: string; notLead?: string }): string[] {
  const top = group?.top ?? []
  const lead = group?.lead ? new RegExp(group.lead, 'i') : null
  const not = group?.notLead ? new RegExp(group.notLead, 'i') : null
  const rank = (n: string) => (query && n.toLowerCase().startsWith(query) ? 0 : 3) + (top.includes(n) ? 0 : lead && lead.test(n) && !not?.test(n) ? 1 : 2)
  return hits.map((n, i) => [rank(n), top.includes(n) ? top.indexOf(n) : i, n] as const).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((x) => x[2])
}

export const REACH_LINE = 'Through Plaid, Aggregate can connect to thousands of US banks and financial institutions.'

export function loadInstitutions(file: URL = new URL('../../../docs/institutions.json', import.meta.url)): InstitutionList | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as InstitutionList
  } catch {
    console.warn('[agfn] docs/institutions.json is missing: the connectors page has no institution search')
    return null
  }
}

/** Over 1,000 rounds down to hundreds ("over 9,600"); small groups are exact. */
export function shownCount(n: number): string {
  return n >= 1000 ? `over ${(Math.floor(n / 100) * 100).toLocaleString('en-US')}` : String(n)
}

export function groupCounts(list: InstitutionList): number[] {
  return INSTITUTION_GROUPS.map(({ bit }) => [...list.flags].filter((f) => parseInt(f, 16) & bit).length)
}

export function institutionsBody(list: InstitutionList | null): string {
  if (!list) return ''
  const updated = new Date(`${list.generated}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  const counts = groupCounts(list)
  return `<section class="dinst" data-institutions>
<h2 id="banks-and-institutions">Banks and institutions</h2>
<p>${REACH_LINE} Search ${shownCount(list.names.length)} US institutions supported by Plaid.</p>
<div class="dchips dinst-chips" role="group" aria-label="Institution type"><button type="button" aria-pressed="true">All</button>${INSTITUTION_GROUPS.map((g, i) => `<button type="button" aria-pressed="false" data-bit="${g.bit}">${g.label} <span>${shownCount(counts[i]!)}</span></button>`).join('')}</div>
<label class="dinst-q"><span class="dsr">Institution name</span><input type="search" placeholder="Institution name" autocomplete="off" spellcheck="false"></label>
<p class="dinst-n" role="status"></p>
<ul class="dinst-list"></ul>
<p class="dfine">From Plaid’s public coverage file, updated ${updated}. Groups follow the Plaid products each institution supports there (crypto exchanges by name), so one can be in several. Listed means supported by Plaid, not that a given account will connect, and availability can change. Being listed doesn’t mean an institution endorses Aggregate.</p>
</section>`
}

export const INSTITUTIONS_CSS = `
.dinst{margin-bottom:36px}
.dinst h2{margin:0 0 6px;font-size:22px;line-height:28px}
.dinst .dinst-chips{margin:14px 0 4px}
.dinst-chips span{color:var(--faint);margin-left:4px}
.dinst-chips button[aria-pressed=true] span{color:inherit;opacity:.75}
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
var input=box.querySelector('input'),say=box.querySelector('.dinst-n'),list=box.querySelector('.dinst-list'),chips=box.querySelectorAll('.dinst-chips button'),bit=0,data=null,MAX=20;
var load=function(){if(data)return Promise.resolve(data);return fetch('${INSTITUTIONS_PATH}').then(function(r){return r.json()}).then(function(j){return data=j})};
var show=function(){var q=input.value.trim().toLowerCase();while(list.firstChild)list.removeChild(list.firstChild);say.textContent='';if(q.length<2&&!bit)return;
load().then(function(j){if(input.value.trim().toLowerCase()!==q)return;var all=j.names,f=j.flags||'',hits=[];
for(var i=0;i<all.length;i++){if(bit&&!(parseInt(f.charAt(i),16)&bit))continue;if(q.length>=2&&all[i].toLowerCase().indexOf(q)<0)continue;hits.push(all[i])}
var g=null;(j.groups||[]).forEach(function(x){if(x.bit===bit)g=x});var top=g&&g.top?g.top:[],lead=g&&g.lead?new RegExp(g.lead,'i'):null,not=g&&g.notLead?new RegExp(g.notLead,'i'):null;
var rank=function(n){return(q&&n.toLowerCase().indexOf(q)===0?0:3)+(top.indexOf(n)>=0?0:lead&&lead.test(n)&&!(not&&not.test(n))?1:2)};
hits.map(function(n,i){var t=top.indexOf(n);return[rank(n),t>=0?t:i,n]}).sort(function(x,y){return x[0]-y[0]||x[1]-y[1]}).map(function(x){return x[2]}).slice(0,MAX).forEach(function(n){var li=document.createElement('li');li.textContent=n;list.appendChild(li)});
say.textContent=!hits.length?'Not on the list. You can still upload statements.':hits.length>MAX?'First '+MAX+' of '+hits.length.toLocaleString('en-US')+'. Type a name to narrow it.':hits.length===1?'1 match.':hits.length+' matches.'}).catch(function(){say.textContent='The list didn’t load. Try again.'})};
for(var c=0;c<chips.length;c++)chips[c].addEventListener('click',function(){for(var k=0;k<chips.length;k++)chips[k].setAttribute('aria-pressed',chips[k]===this?'true':'false');bit=Number(this.getAttribute('data-bit')||0);show()});
input.addEventListener('input',show);
})();`
