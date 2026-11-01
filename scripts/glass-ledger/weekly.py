"""Glass Ledger: draft one week's public log from the demo company's activity log.

Reads GET /v1/activity (who did what, when, to which record; amounts in arguments are already redacted by the
server), plus GET /v1/records/{id} for each correction's target, only to see whether it was planted (the Glass Ledger
workspace ends a planted row's bank text with " [planted]"). Never reads statements, documents or secrets. Synthetic
Glass Ledger workspace only.

Usage: AGFN_KEY=agfn_live_… python3 -I weekly.py https://<demo-host> 2026-10-27 > week.md
  The key is a read-only key on the demo workspace. The date is the first day of the week (7 days are covered).
The output is a draft: counts and the raw list of corrections are filled in; the narrative lines marked [WRITE]
are written by a person, from the rows shown.
"""
import datetime as dt, json, os, sys, urllib.parse, urllib.request
from collections import Counter, defaultdict

host, start = sys.argv[1].rstrip('/'), dt.date.fromisoformat(sys.argv[2])
end = start + dt.timedelta(days=7)
key = os.environ['AGFN_KEY']

# Actions that mean something was caught and put right. Matched by substring against the action name.
CORRECTIONS = ('undo', 'void_record', 'update_record', 'reopen_period', 'resolve_review_item', 'revert')

def get(path):
    req = urllib.request.Request(host + path, headers={'Authorization': f'Bearer {key}', 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = json.load(r)
    return body.get('data', body)

def page(before=None):
    data = get('/v1/activity?limit=200' + (f'&before_seq={before}' if before else ''))
    return data.get('activity', []), data.get('next_before_seq')

PLANTED = ' [planted]'
_planted = {}
def texts(v):
    """Every bank-text string in a record, with whether it was cut short. Bank text arrives either as a plain string
    or wrapped as {"untrusted_text": {"text": …, "truncated": …}}."""
    if isinstance(v, dict):
        u = v.get('untrusted_text')
        if isinstance(u, dict) and isinstance(u.get('text'), str):
            yield u['text'], bool(u.get('truncated'))
            return
        for x in v.values():
            yield from texts(x)
    elif isinstance(v, list):
        for x in v:
            yield from texts(x)
    elif isinstance(v, str):
        yield v, False

def planted(r):
    """'planted' or 'real' when the target is a record, else 'unknown' (say which by hand). Never guess a catch:
    text that was cut short could have lost the suffix, so it counts as unknown, not real."""
    rid = r.get('target_id')
    if not rid or r.get('target_type') not in (None, 'record', 'transaction', 'invoice', 'bill'):
        return 'unknown'
    if rid not in _planted:
        try:
            found = list(texts(get(f'/v1/records/{urllib.parse.quote(rid)}')))
            _planted[rid] = ('planted' if any(t.endswith(PLANTED) for t, _ in found)
                             else 'unknown' if any(cut for _, cut in found) else 'real')
        except Exception:
            _planted[rid] = 'unknown'
    return _planted[rid]

rows, before = [], None
while True:
    batch, before = page(before)
    rows += batch
    oldest = batch[-1]['at'][:10] if batch else None
    if not before or not batch or dt.date.fromisoformat(oldest) < start:
        break
week = [r for r in rows if start <= dt.date.fromisoformat(r['at'][:10]) < end]
ai = [r for r in week if r.get('actor') == 'agent']

by_who = defaultdict(Counter)
for r in week:
    by_who[r.get('who', '?')][r.get('status', '?')] += 1
fixes = [r for r in week if any(c in str(r.get('action', '')) for c in CORRECTIONS)]
held = [r for r in week if r.get('status') in ('held', 'denied')]

out = [f'# Glass Ledger, week of {start:%B %-d, %Y}', '',
       '> The books of a made-up company, kept by AI agents in public. Synthetic data only. '
       'Amounts in agent requests are redacted by Aggregate itself.', '',
       '**This week in one line:** [WRITE]', '',
       '## Who did what', '', '| Who | Questions asked | Changes applied | Held for review | Denied | Failed |', '|---|---|---|---|---|---|']
for who, c in sorted(by_who.items(), key=lambda kv: -sum(kv[1].values())):
    other = sum(n for k, n in c.items() if k not in ('applied', 'held', 'denied', 'failed'))
    out.append(f"| {who} | {other} | {c['applied']} | {c['held']} | {c['denied']} | {c['failed']} |")
out += ['', f'{len(week)} actions in total, {len(ai)} by AI connections.', '',
        '## Mistakes caught and put right', '',
        '"planted" = a case the generator put there on purpose to test the agents; say so in the [WRITE] line. '
        '"unknown" = check by hand before publishing.', '']
if fixes:
    for r in fixes:
        out.append(f"- {r['at'][:16].replace('T', ' ')} · {r.get('who')} · `{r.get('action')}` on "
                   f"{r.get('target_type', 'record')} `{r.get('target_id', '')}` ({', '.join(r.get('companies') or [])}) "
                   f"· {r.get('status')} · {planted(r)} · [WRITE: what was wrong and who caught it]")
else:
    out.append('- None this week. [WRITE: say so plainly; a quiet week is fine.]')
out += ['', '## Stopped by the rules', '']
if held:
    for r in held:
        out.append(f"- {r['at'][:16].replace('T', ' ')} · {r.get('who')} · `{r.get('action')}` · {r.get('status')} "
                   f"· [WRITE: why it was held or denied]")
else:
    out.append('- Nothing held or denied.')
out += ['', '## What we changed because of it', '', '- [WRITE: rule, prompt or code change, with a link]', '',
        '---', '', 'Every row above comes from the demo workspace’s activity log. Ask your own AI the same questions: '
        '[the public demo link].']
print('\n'.join(out))
