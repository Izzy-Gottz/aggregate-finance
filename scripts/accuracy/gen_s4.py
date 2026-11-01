#!/usr/bin/env python3
"""S4 VC: writes apps/server/src/accuracy/s4-vc/fixture.json (see gen_s2.py for the shape).

Harbor Seed Fund I, a venture fund kept as a company, Apr-Sep 2026, as seen on 2026-10-12:
- one bank account (Mercury); $25M committed by three LPs (Granite Pension Fund 50%, Alder Family Office 30%,
  Juniper Endowment 20%)
- capital calls on Apr 15 and Jul 15 ($2M each, wired by each LP pro rata)
- the 2% management fee, quarterly in advance, to Harbor Seed Management LLC; fund admin (Carta) monthly; legal
  (Cooley) in May and August; a $30 fee on every outgoing wire
- five investments wired out; Pinecrest AI is acquired in August and the fund receives $1.2M; $1M goes back to the
  LPs on Sep 15, pro rata
The fund tells Aggregate what its money is with rules (as a fund's bookkeeper would before portfolio tracking):
capital calls and distributions to LPs are partners' capital; investments and exit proceeds are other assets (cost
and its return, not spending or sales).
"""
import json
import os
import sys

OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'apps', 'server', 'src', 'accuracy', 's4-vc', 'fixture.json')
MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']
NOW = '2026-10-12T16:00:00Z'
AT = '2026-10-11T08:00:00Z'
OPENING = {'fund_chk': 1_850_000_00}
LPS = [('Granite Pension Fund', 50), ('Alder Family Office', 30), ('Juniper Endowment', 20)]
CALLS = [('2026-04-15', 2_000_000_00, 2), ('2026-07-15', 2_000_000_00, 3)]
INVESTMENTS = [
    ('2026-04-20', 'Tidewell Health', 500_000_00, 'SERIES SEED'),
    ('2026-05-12', 'Corvid Robotics', 750_000_00, 'SAFE'),
    ('2026-06-18', 'Pinecrest AI', 400_000_00, 'SERIES SEED'),
    ('2026-07-22', 'Brightwave Energy', 1_000_000_00, 'SERIES A'),
    ('2026-09-09', 'Quillmark', 300_000_00, 'SAFE'),
]
EXIT = ('2026-08-27', 'Pinecrest AI', 1_200_000_00)
DISTRIBUTION = ('2026-09-15', 1_000_000_00)
MGMT_FEE = 125_000_00          # 2% a year of $25M, paid quarterly
WIRE_FEE = 30_00


def usd(minor):
    return {'minor': minor, 'currency': 'USD'}


def main():
    bank = []

    def txn(ext, d, minor, desc, raw, **extra):
        e = {'type': 'txn.upsert', 'externalId': ext, 'connectionId': '$conn', 'accountExternalId': 'fund_chk', 'date': d, 'amount': usd(minor), 'status': 'posted', 'counterparty': desc, 'rawText': raw}
        e.update(extra)
        bank.append(e)

    def wire_out(ext, d, minor, desc, raw):
        txn(ext, d, -minor, desc, raw)
        txn(f'{ext}_fee', d, -WIRE_FEE, 'Mercury', 'OUTGOING WIRE FEE')

    bank.append({'type': 'account.upsert', 'externalId': 'fund_chk', 'connectionId': '$conn', 'name': 'Fund Checking', 'accountType': 'depository', 'currency': 'USD', 'mask': '4410', 'institution': 'Mercury'})

    for d, amount, n in CALLS:
        for lp, pct in LPS:
            slug = lp.split()[0].lower()
            txn(f'call{n}_{slug}', d, amount * pct // 100, lp, f'WIRE IN {lp.upper()} CAPITAL CALL {n}')
    for d in ('2026-04-01', '2026-07-01'):
        wire_out(f'mgmt_{d[:7]}', d, MGMT_FEE, 'Harbor Seed Management LLC', f'WIRE OUT HARBOR SEED MANAGEMENT MGMT FEE Q{(int(d[5:7]) - 1) // 3 + 1}')
    for m in MONTHS:
        txn(f'carta_{m}', f'{m}-05', -1_250_00, 'Carta', 'CARTA FUND ADMIN ACH')
    for d, amt in (('2026-05-28', 18_000_00), ('2026-08-26', 12_400_00)):
        txn(f'cooley_{d[:7]}', d, -amt, 'Cooley LLP', 'COOLEY LLP ACH LEGAL')
    for d, co, amt, sec in INVESTMENTS:
        wire_out(f'inv_{co.split()[0].lower()}', d, amt, co, f'WIRE OUT {co.upper()} {sec} INVESTMENT')
    d, co, amt = EXIT
    txn('exit_pinecrest', d, amt, 'Northwind Software', f'WIRE IN NORTHWIND SOFTWARE ACQUISITION PROCEEDS {co.upper()}')
    d, amt = DISTRIBUTION
    for lp, pct in LPS:
        wire_out(f'dist_{lp.split()[0].lower()}', d, amt * pct // 100, lp, f'WIRE OUT {lp.upper()} LP DISTRIBUTION 1')

    cur = OPENING['fund_chk'] + sum(e['amount']['minor'] for e in bank if e['type'] == 'txn.upsert')
    bank.append({'type': 'balance.snapshot', 'externalId': 'fund_chk_now', 'connectionId': '$conn', 'accountExternalId': 'fund_chk', 'at': AT, 'current': usd(cur)})

    co = 'Harbor Seed Fund I'
    rule = lambda key, text, cat: {'do': 'create_rule', 'args': {'company': co, 'match': {'description_contains': text}, 'set': {'category': cat}, 'apply_to_existing': True, 'idempotency_key': f's4-rule-{key}'}}
    fixture = {
        'scenario': 's4-vc',
        'now': NOW,
        'timeZone': 'UTC',
        'company': co,
        'openingBalances': OPENING,
        'connections': [{'id': 'bank', 'key': 'plaid', 'name': 'Mercury', 'entity': co, 'events': bank}],
        'actions': [
            rule('calls', 'CAPITAL CALL', 'paid_in_capital'),
            rule('dist', 'LP DISTRIBUTION', 'paid_in_capital'),
            rule('invest', 'INVESTMENT', 'other_assets'),
            rule('exit', 'ACQUISITION PROCEEDS', 'other_assets'),
            {'do': 'confirm_all_matches'},
        ],
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(fixture, f, indent=1)
        f.write('\n')
    print(f'wrote {os.path.normpath(OUT)}: {len(bank)} events, cash now {cur / 100:,.2f}')


if __name__ == '__main__':
    sys.exit(main())
