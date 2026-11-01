#!/usr/bin/env python3
"""S3 Operator: writes apps/server/src/accuracy/s3-operator/fixture.json (see gen_s2.py for the shape).

Dana Park runs three companies and has a Personal space, Apr-Sep 2026, as seen on 2026-10-12:
- Northstar Labs (USD): Chase checking and an Amex card; Globex pays monthly; pays Dana's salary
- Brightline Studio (USD): Chase checking; Initech pays monthly; pays Northstar's Amex bill every month (a card paid
  from another company's bank); invoices Northstar $6,000 in August (an invoice between own companies)
- Northstar sends Brightline $20,000 on Jul 15 (a transfer between own companies)
- Kestrel GmbH (EUR books): a German bank account loaded from two CSV exports that overlap in June and July
- Personal: Chase checking (Dana's salary, rent, groceries)
FX: the fixture carries its own EUR->USD rates (one per month), seeded before anything syncs.
"""
import json
import os
import sys
from datetime import date, timedelta

OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'apps', 'server', 'src', 'accuracy', 's3-operator', 'fixture.json')
MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']
NOW = '2026-10-12T16:00:00Z'
AT = '2026-10-11T08:00:00Z'
OPENING = {'ns_chk': 15_000_000, 'bl_chk': 6_000_000, 'per_chk': 1_200_000}
EUR_USD = {'2026-04': '1.0720', '2026-05': '1.0835', '2026-06': '1.0910', '2026-07': '1.1040', '2026-08': '1.0985', '2026-09': '1.1120', '2026-10': '1.1075'}


def usd(minor):
    return {'minor': minor, 'currency': 'USD'}


def main():
    chase = []

    def acct(ext, name, typ, mask):
        chase.append({'type': 'account.upsert', 'externalId': ext, 'connectionId': '$conn', 'name': name, 'accountType': typ, 'currency': 'USD', 'mask': mask, 'institution': 'Chase'})

    def txn(ext, a, d, minor, desc, **extra):
        e = {'type': 'txn.upsert', 'externalId': ext, 'connectionId': '$conn', 'accountExternalId': a, 'date': d, 'amount': usd(minor), 'status': 'posted', 'counterparty': desc, 'rawText': desc.upper()}
        e.update(extra)
        chase.append(e)

    acct('ns_chk', 'Northstar Checking', 'depository', '2001')
    acct('ns_amex', 'Northstar Amex', 'credit_card', '3005')
    acct('bl_chk', 'Brightline Checking', 'depository', '2002')
    acct('per_chk', 'Dana Checking', 'depository', '2003')

    for mi, m in enumerate(MONTHS):
        # Northstar
        txn(f'ns_rent_{m}', 'ns_chk', f'{m}-01', -400_000, 'Harbor Office Rent')
        txn(f'ns_aws_{m}', 'ns_chk', f'{m}-04', -(210_000 + mi * 3_700), 'Amazon Web Services')
        txn(f'ns_salary_{m}', 'ns_chk', f'{m}-15', -750_000, 'Dana Park Salary', rawText='NORTHSTAR LABS PAYROLL DANA PARK')
        txn(f'per_salary_{m}', 'per_chk', f'{m}-15', 750_000, 'Northstar Labs', rawText='NORTHSTAR LABS PAYROLL', categoryHint='INCOME_WAGES')
        txn(f'ns_globex_{m}', 'ns_chk', f'{m}-20', 1_500_000, 'Globex Corp', rawText='GLOBEX CORP ACH')
        amex = [(5, 'Figma', 7_500), (8, 'Adobe', 5_999), (12, 'Delta Air Lines', 48_000 + mi * 1_000)]
        for day, who, amt in amex:
            txn(f'ns_amex_{m}_{day}', 'ns_amex', f'{m}-{day:02d}', -amt, who)
        paid = sum(a for _, _, a in amex)
        # Brightline's bank pays Northstar's card.
        txn(f'bl_amexpay_{m}', 'bl_chk', f'{m}-22', -paid, 'Amex Payment', rawText='AMEX EPAYMENT ACH PMT', linkRefs={'card_payment': f'amex_{m}'})
        txn(f'ns_amexpay_{m}', 'ns_amex', f'{m}-22', paid, 'Payment Received', linkRefs={'card_payment': f'amex_{m}'})
        # Brightline
        txn(f'bl_rent_{m}', 'bl_chk', f'{m}-01', -200_000, 'Studio Lease')
        txn(f'bl_upwork_{m}', 'bl_chk', f'{m}-10', -300_000, 'Upwork')
        txn(f'bl_initech_{m}', 'bl_chk', f'{m}-18', 900_000, 'Initech', rawText='INITECH ACH')
        # Personal
        txn(f'per_rent_{m}', 'per_chk', f'{m}-01', -260_000, 'Elm Street Apartments', categoryHint='RENT_AND_UTILITIES_RENT')
        txn(f'per_groc_{m}', 'per_chk', f'{m}-09', -(31_250 + mi * 500), 'Trader Joes', categoryHint='FOOD_AND_DRINK_GROCERIES')

    # Northstar sends Brightline $20,000; both sides seen.
    txn('ns_ic_out', 'ns_chk', '2026-07-15', -2_000_000, 'Transfer to Brightline Studio', linkRefs={'transfer': 'ic_0715'})
    txn('bl_ic_in', 'bl_chk', '2026-07-15', 2_000_000, 'Transfer from Northstar Labs', linkRefs={'transfer': 'ic_0715'})
    # Northstar pays Brightline's August invoice.
    txn('ns_pays_bl', 'ns_chk', '2026-08-20', -600_000, 'Brightline Studio', rawText='BRIGHTLINE STUDIO INV-B-100')
    txn('bl_paid_by_ns', 'bl_chk', '2026-08-20', 600_000, 'Northstar Labs', rawText='NORTHSTAR LABS INV-B-100')

    rows = [e for e in chase if e['type'] == 'txn.upsert']
    for a in ('ns_chk', 'bl_chk', 'per_chk', 'ns_amex'):
        cur = OPENING.get(a, 0) + sum(e['amount']['minor'] for e in rows if e['accountExternalId'] == a)
        chase.append({'type': 'balance.snapshot', 'externalId': f'{a}_now', 'connectionId': '$conn', 'accountExternalId': a, 'at': AT, 'current': usd(cur)})

    qbo = [
        {'type': 'invoice.upsert', 'externalId': 'invB100', 'connectionId': '$conn', 'direction': 'receivable', 'number': 'INV-B-100', 'counterparty': 'Northstar Labs', 'issueDate': '2026-08-01', 'dueDate': '2026-08-31', 'total': usd(600_000), 'amountPaid': usd(600_000), 'status': 'paid'},
        {'type': 'payment.applied', 'externalId': 'payB100', 'connectionId': '$conn', 'direction': 'receivable', 'date': '2026-08-20', 'amount': usd(600_000), 'counterparty': 'Northstar Labs', 'applications': [{'invoiceExternalId': 'invB100', 'amount': usd(600_000)}], 'reference': 'INV-B-100'},
    ]

    # Kestrel's bank, as two CSV exports (Date,Description,Amount; EUR): Apr-Jul and Jun-Sep. June and July are in both.
    kestrel = []
    for mi, m in enumerate(MONTHS):
        kestrel += [(f'{m}-01', 'Miete Buero Berlin', '-1800.00'), (f'{m}-03', 'Hetzner Online GmbH', f'-{129.90 + mi:.2f}'), (f'{m}-25', 'Siemens AG', '7500.00'), (f'{m}-28', 'Kontofuehrung', '-9.50')]
    # Running balance after each row (EUR 25,000.00 on Apr 1), as the bank's export shows it.
    bal, running = 2_500_000, {}
    for d, t, a in kestrel:
        bal += round(float(a) * 100)
        running[(d, t)] = bal
    money = lambda m: f'{m // 100}.{m % 100:02d}' if m >= 0 else f'-{(-m) // 100}.{(-m) % 100:02d}'
    csv = lambda rows: 'Date,Description,Amount,Balance\n' + ''.join(f'{d},{t},{a},{money(running[(d, t)])}\n' for d, t, a in rows)
    first = [r for r in kestrel if r[0] < '2026-08-01']
    second = [r for r in kestrel if r[0] >= '2026-06-01']

    rates = []
    d = date(2026, 4, 1)
    while d <= date(2026, 10, 12):
        rates.append({'date': d.isoformat(), 'from': 'EUR', 'to': 'USD', 'rate': EUR_USD[d.isoformat()[:7]]})
        d += timedelta(days=1)

    fixture = {
        'scenario': 's3-operator',
        'now': NOW,
        'timeZone': 'UTC',
        'company': 'Northstar Labs',
        'companies': [{'name': 'Brightline Studio', 'currency': 'USD'}, {'name': 'Kestrel GmbH', 'currency': 'EUR'}],
        'rates': rates,
        'openingBalances': {**OPENING, 'kestrel_eur': 2_500_000},
        'connections': [
            {'id': 'chase', 'key': 'plaid', 'name': 'Chase', 'entity': None,
             'assign': {'ns_chk': 'Northstar Labs', 'ns_amex': 'Northstar Labs', 'bl_chk': 'Brightline Studio', 'per_chk': 'Personal'}, 'events': chase},
            {'id': 'qbo', 'key': 'quickbooks', 'name': 'QuickBooks', 'entity': 'Brightline Studio', 'events': qbo},
        ],
        'uploads': [
            {'entity': 'Kestrel GmbH', 'name': 'kestrel-apr-jul.csv', 'csv': csv(first)},
            {'entity': 'Kestrel GmbH', 'name': 'kestrel-jun-sep.csv', 'csv': csv(second)},
        ],
        'actions': [
            # Who the regular customers are, told once as rules (past rows too).
            {'do': 'create_rule', 'args': {'company': 'Northstar Labs', 'match': {'counterparty': 'Globex Corp'}, 'set': {'kind': 'revenue', 'category': 'revenue'}, 'apply_to_existing': True, 'idempotency_key': 's3-rule-globex'}},
            {'do': 'create_rule', 'args': {'company': 'Brightline Studio', 'match': {'counterparty': 'Initech'}, 'set': {'kind': 'revenue', 'category': 'revenue'}, 'apply_to_existing': True, 'idempotency_key': 's3-rule-initech'}},
            {'do': 'create_rule', 'args': {'company': 'Kestrel GmbH', 'match': {'counterparty': 'Siemens AG'}, 'set': {'kind': 'revenue', 'category': 'revenue'}, 'apply_to_existing': True, 'idempotency_key': 's3-rule-siemens'}},
            # Dana's salary is pay, not money owed between Northstar and her: she rejects those suggestions.
            {'do': 'reject_matches', 'externalIds': [f'per_salary_{m}' for m in MONTHS]},
            {'do': 'confirm_all_matches'},
        ],
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(fixture, f, indent=1)
        f.write('\n')
    print(f'wrote {os.path.normpath(OUT)}: {sum(len(c["events"]) for c in fixture["connections"])} events, {len(kestrel)} Kestrel rows ({len(first)} + {len(second)} uploaded)')


if __name__ == '__main__':
    sys.exit(main())
