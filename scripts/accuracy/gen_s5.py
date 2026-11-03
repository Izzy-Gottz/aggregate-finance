#!/usr/bin/env python3
"""S5 Two sides of the same money: writes apps/server/src/accuracy/s5-same-money/fixture.json.

Northwind Supply and its sister company Eastside Labs, as seen on 2026-10-12. Each case below has one payment that two
sources can show, or a month that can mislead:
- a second source: the same Mercury account through Plaid and directly, with the August rows in both
- processor vs books: invoice 1038 paid through Stripe and also recorded as paid in QuickBooks
- a taxed refund: a QuickBooks refund receipt of $10.00 + $0.80 tax, and the $10.80 Stripe refund
- intercompany: a wire with both sides seen, and an entry with only one side (add_entry)
- a partial first month: history starts on July 16

Nothing here imports or calls Aggregate code. key.py computes the answers from this file alone.
"""
import json
import os
import sys

OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'apps', 'server', 'src', 'accuracy', 's5-same-money', 'fixture.json')
NORTHWIND, EASTSIDE = 'Northwind Supply', 'Eastside Labs'
NOW = '2026-10-12T16:00:00Z'
SNAPSHOT_AT = '2026-10-11T08:00:00Z'
OPENING = 5_000_000


def usd(minor):
    return {'minor': minor, 'currency': 'USD'}


def main():
    def acct(ext, name, typ, mask=None):
        e = {'type': 'account.upsert', 'externalId': ext, 'connectionId': '$conn', 'name': name, 'accountType': typ, 'currency': 'USD', 'institution': 'Mercury'}
        if mask:
            e['mask'] = mask
        return e

    def txn(ext, account, day, minor, who):
        return {'type': 'txn.upsert', 'externalId': ext, 'connectionId': '$conn', 'accountExternalId': account, 'date': day, 'amount': usd(minor), 'status': 'posted', 'counterparty': who, 'rawText': who.upper()}

    def snap(ext, account, minor):
        return {'type': 'balance.snapshot', 'externalId': ext, 'connectionId': '$conn', 'accountExternalId': account, 'at': SNAPSHOT_AT, 'current': usd(minor)}

    def stripe_row(ext, at, kind, gross, fee, who=None, **extra):
        e = {'type': 'processor.balance_txn', 'externalId': ext, 'connectionId': '$conn', 'accountExternalId': 'stripe_bal', 'at': at, 'kind': kind, 'gross': usd(gross), 'fee': usd(fee), 'net': usd(gross - fee)}
        if who:
            e['counterparty'] = who
        e.update(extra)
        return e

    rows = [
        txn('aws_jul', 'chk', '2026-07-20', -100_000, 'Amazon Web Services'),
        txn('rent_aug', 'chk', '2026-08-01', -500_000, 'Pier Properties Rent'),
        txn('payout_aug', 'chk', '2026-08-12', 9_630, 'Stripe Transfer'),
        txn('wire_east', 'chk', '2026-08-15', -200_000, 'Eastside Labs'),
        txn('aws_aug', 'chk', '2026-08-20', -120_000, 'Amazon Web Services'),
        txn('rent_sep', 'chk', '2026-09-01', -500_000, 'Pier Properties Rent'),
        txn('payout_sep', 'chk', '2026-09-12', 47_440, 'Stripe Transfer'),
        txn('aws_sep', 'chk', '2026-09-20', -120_000, 'Amazon Web Services'),
        txn('rent_oct', 'chk', '2026-10-01', -500_000, 'Pier Properties Rent'),
    ]
    closing = OPENING + sum(t['amount']['minor'] for t in rows)
    plaid = [acct('chk', 'Mercury Checking', 'depository', '4410'), *rows, snap('chk_now', 'chk', closing)]
    direct = [acct('direct_chk', 'Mercury Checking', 'depository', '4410')]
    direct += [{**t, 'externalId': f'direct_{t["externalId"]}', 'accountExternalId': 'direct_chk'} for t in rows if t['date'].startswith('2026-08')]
    direct.append(snap('direct_now', 'direct_chk', closing))
    east = [acct('east_chk', 'Eastside Checking', 'depository', '8820'), txn('wire_in', 'east_chk', '2026-08-15', 200_000, 'Northwind Supply'), txn('east_tools', 'east_chk', '2026-09-08', -50_000, 'Figma'), snap('east_now', 'east_chk', 150_000)]

    stripe = [
        acct('stripe_bal', 'Stripe balance', 'processor_balance'),
        stripe_row('ch_globex', '2026-08-10T15:00:00Z', 'charge', 10_000, 370, 'Globex Corp'),
        stripe_row('po_aug', '2026-08-11T12:00:00Z', 'payout', -9_630, 0, payoutExternalId='po_aug', arrivalDate='2026-08-12'),
        stripe_row('ch_initech', '2026-09-03T15:00:00Z', 'charge', 50_000, 1_480, 'Initech'),
        stripe_row('re_globex', '2026-09-05T10:00:00Z', 'refund', -1_080, 0, 'Globex Corp'),
        stripe_row('po_sep', '2026-09-10T12:00:00Z', 'payout', -47_440, 0, payoutExternalId='po_sep', arrivalDate='2026-09-12'),
        snap('stripe_now', 'stripe_bal', 0),
    ]
    qbo = [
        {'type': 'invoice.upsert', 'externalId': 'inv_1038', 'connectionId': '$conn', 'direction': 'receivable', 'number': '1038', 'counterparty': 'Globex Corp', 'issueDate': '2026-08-01', 'dueDate': '2026-08-31', 'total': usd(10_000), 'amountPaid': usd(10_000), 'status': 'paid'},
        {'type': 'payment.applied', 'externalId': 'pay_1038', 'connectionId': '$conn', 'direction': 'receivable', 'date': '2026-08-09', 'amount': usd(10_000), 'counterparty': 'Globex Corp', 'applications': [{'invoiceExternalId': 'inv_1038', 'amount': usd(10_000)}]},
        {'type': 'credit_note.upsert', 'externalId': 'refundreceipt:1042', 'connectionId': '$conn', 'direction': 'receivable', 'number': '1042', 'date': '2026-09-04', 'amount': usd(1_080), 'tax': usd(80), 'appliedTo': 'refund', 'counterparty': 'Globex Corp', 'status': 'applied', 'applications': []},
    ]
    fixture = {
        'scenario': 's5-same-money',
        'now': NOW,
        'timeZone': 'UTC',
        'company': NORTHWIND,
        'companies': [{'name': EASTSIDE, 'currency': 'USD'}],
        'openingBalances': {'chk': OPENING},
        'connections': [
            {'id': 'plaid', 'key': 'plaid', 'name': 'Mercury', 'entity': NORTHWIND, 'events': plaid},
            {'id': 'direct', 'key': 'plaid', 'name': 'Mercury direct', 'entity': NORTHWIND, 'events': direct},
            {'id': 'east', 'key': 'plaid', 'name': 'Mercury Eastside', 'entity': EASTSIDE, 'events': east},
            {'id': 'stripe', 'key': 'stripe', 'name': 'Stripe', 'entity': NORTHWIND, 'events': stripe},
            {'id': 'qbo', 'key': 'quickbooks', 'name': 'QuickBooks', 'entity': NORTHWIND, 'events': qbo},
        ],
        'actions': [
            {'do': 'add_entry', 'args': {'company': NORTHWIND, 'kind': 'intercompany', 'amount': {'amount': '1500.00', 'currency': 'USD'}, 'date': '2026-09-10', 'paid_by': NORTHWIND, 'to_company': EASTSIDE, 'description': 'Moved to Eastside for payroll', 'idempotency_key': 's5-intercompany-entry-1'}},
            {'do': 'confirm_all_matches'},
        ],
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(fixture, f, indent=1)
        f.write('\n')
    print(f'wrote {os.path.normpath(OUT)}: {sum(len(c["events"]) for c in fixture["connections"])} events, {len(fixture["actions"])} actions')


if __name__ == '__main__':
    sys.exit(main())
