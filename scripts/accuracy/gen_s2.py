#!/usr/bin/env python3
"""S2 Solo founder: writes apps/server/src/accuracy/s2-founder/fixture.json.

The fixture is what the providers send (connector events, connectionId as "$conn") plus what the founder does in the
app (actions). It is written once and committed; key.py computes the answers from this file alone. Nothing here
imports or calls Aggregate code.

Lumen Labs, one company, Apr-Sep 2026 (+ early October), as seen on 2026-10-12:
- Mercury checking (bank) and a Mercury card: rent, AWS, Gusto payroll debits, card purchases, the card paid off monthly
- Stripe: charges (2.9% + 30c fees), one refund, payouts landing in checking two days later, subscriptions
- QuickBooks: four invoices (paid, partly paid and overdue, open, overdue unpaid) with their payments, one bill
- a $250,000 SAFE wired in, and a $20,000 loan from the founder
"""
import json
import os
import sys

OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'apps', 'server', 'src', 'accuracy', 's2-founder', 'fixture.json')

MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']
OPENING_CHECKING = 18_000_000  # $180,000.00 on 2026-04-01, before any row below
NOW = '2026-10-12T16:00:00Z'
SNAPSHOT_AT = '2026-10-11T08:00:00Z'


def usd(minor):
    return {'minor': minor, 'currency': 'USD'}


def stripe_fee(gross):
    # 2.9% + 30c, rounded half up (Stripe's US card fee).
    return (gross * 29 + 500) // 1000 + 30


def main():
    bank, card, stripe, qbo = [], [], [], []
    bank.append({'type': 'account.upsert', 'externalId': 'chk', 'connectionId': '$conn', 'name': 'Mercury Checking', 'accountType': 'depository', 'currency': 'USD', 'institution': 'Mercury', 'mask': '4410'})
    bank.append({'type': 'account.upsert', 'externalId': 'card', 'connectionId': '$conn', 'name': 'Mercury Card', 'accountType': 'credit_card', 'currency': 'USD', 'institution': 'Mercury', 'mask': '7710'})

    def txn(ext, acct, date, minor, desc, **extra):
        e = {'type': 'txn.upsert', 'externalId': ext, 'connectionId': '$conn', 'accountExternalId': acct, 'date': date, 'amount': usd(minor), 'status': 'posted', 'counterparty': desc, 'rawText': desc.upper()}
        e.update(extra)
        return e

    stripe.append({'type': 'account.upsert', 'externalId': 'stripe_bal', 'connectionId': '$conn', 'name': 'Stripe balance', 'accountType': 'processor_balance', 'currency': 'USD', 'institution': 'Stripe'})

    # Stripe charges per month: (day, customer, gross). Paid out on the 20th; lands in checking on the 22nd.
    charge_plan = [(3, 'Acme Corp', 120_000), (6, 'Dunder Mifflin', 48_500), (9, 'Initech', 250_000), (12, 'Umbrella', 75_000), (15, 'Stark Industries', 310_000), (18, 'Wayne Enterprises', 99_900)]
    # After the September payout: still in the Stripe balance on Oct 11.
    late_sep = [(24, 'Acme Corp', 64_000), (27, 'Umbrella', 22_500)]

    card_plan = [(5, 'Figma', 4_500), (7, 'Notion', 9_600), (11, 'Delta Air Lines', 61_240), (19, 'Uber', 3_870)]

    for mi, m in enumerate(MONTHS):
        # Bank: rent, AWS, payroll (two pay dates, net and taxes as separate debits).
        bank.append(txn(f'rent_{m}', 'chk', f'{m}-01', -650_000, 'Pier Properties Rent'))
        bank.append(txn(f'aws_{m}', 'chk', f'{m}-03', -123_456, 'Amazon Web Services'))
        for d in ('15', '28'):
            bank.append(txn(f'gusto_net_{m}_{d}', 'chk', f'{m}-{d}', -915_000, 'Gusto Net', rawText=f'GUSTO NET {m.replace("-", "")}{d}'))
            bank.append(txn(f'gusto_tax_{m}_{d}', 'chk', f'{m}-{d}', -285_000, 'Gusto Tax', rawText=f'GUSTO TAX {m.replace("-", "")}{d}'))
        # Card purchases (Delta varies by month), paid off in full on the 25th from checking.
        card_total = 0
        for day, who, amt in card_plan:
            a = amt + (mi * 1_115 if who == 'Delta Air Lines' else 0)
            card.append(txn(f'card_{m}_{day}', 'card', f'{m}-{day:02d}', -a, who))
            card_total += a
        bank.append(txn(f'cardpay_out_{m}', 'chk', f'{m}-25', -card_total, 'Mercury Card Payment', linkRefs={'card_payment': f'cp_{m}'}))
        card.append(txn(f'cardpay_in_{m}', 'card', f'{m}-25', card_total, 'Payment Thank You', linkRefs={'card_payment': f'cp_{m}'}))

        # Stripe: charges, an August refund of Initech's charge (Stripe keeps the fee), the payout of what's available.
        net_total = 0
        for day, who, gross in charge_plan:
            fee = stripe_fee(gross)
            stripe.append({'type': 'processor.balance_txn', 'externalId': f'ch_{m}_{day}', 'connectionId': '$conn', 'accountExternalId': 'stripe_bal', 'at': f'{m}-{day:02d}T15:00:00Z', 'kind': 'charge', 'gross': usd(gross), 'fee': usd(fee), 'net': usd(gross - fee), 'customer': who})
            net_total += gross - fee
        if m == '2026-08':
            stripe.append({'type': 'processor.balance_txn', 'externalId': 're_2026-08', 'connectionId': '$conn', 'accountExternalId': 'stripe_bal', 'at': '2026-08-16T10:00:00Z', 'kind': 'refund', 'gross': usd(-250_000), 'fee': usd(0), 'net': usd(-250_000), 'customer': 'Initech', 'sourceExternalId': 'ch_2026-08_9'})
            net_total -= 250_000
        stripe.append({'type': 'processor.balance_txn', 'externalId': f'po_{m}', 'connectionId': '$conn', 'accountExternalId': 'stripe_bal', 'at': f'{m}-20T12:00:00Z', 'kind': 'payout', 'gross': usd(-net_total), 'fee': usd(0), 'net': usd(-net_total), 'payoutExternalId': f'po_{m}', 'arrivalDate': f'{m}-22'})
        bank.append(txn(f'stripe_dep_{m}', 'chk', f'{m}-22', net_total, 'Stripe Transfer', rawText=f'STRIPE TRANSFER ST-{m.replace("-", "")}'))

    late_net = 0
    for day, who, gross in late_sep:
        fee = stripe_fee(gross)
        stripe.append({'type': 'processor.balance_txn', 'externalId': f'ch_2026-09_{day}', 'connectionId': '$conn', 'accountExternalId': 'stripe_bal', 'at': f'2026-09-{day:02d}T15:00:00Z', 'kind': 'charge', 'gross': usd(gross), 'fee': usd(fee), 'net': usd(gross - fee), 'customer': who})
        late_net += gross - fee
    stripe.append({'type': 'balance.snapshot', 'externalId': 'stripe_bal_now', 'connectionId': '$conn', 'accountExternalId': 'stripe_bal', 'at': SNAPSHOT_AT, 'current': usd(late_net)})

    # Subscriptions (MRR): two monthly, one yearly, one canceled in August.
    subs = [
        ('sub_acme', 'Acme Corp', 'active', 120_000, 'month', '2026-01-03T00:00:00Z', None),
        ('sub_umbrella', 'Umbrella', 'active', 75_000, 'month', '2026-02-12T00:00:00Z', None),
        ('sub_wayne', 'Wayne Enterprises', 'active', 8_325, 'year', '2026-03-18T00:00:00Z', None),  # $999/yr = $83.25/mo
        ('sub_dunder', 'Dunder Mifflin', 'canceled', 48_500, 'month', '2026-02-06T00:00:00Z', '2026-08-31T00:00:00Z'),
    ]
    for ext, who, status, mrr, interval, started, ended in subs:
        e = {'type': 'subscription.upsert', 'externalId': ext, 'connectionId': '$conn', 'customer': who, 'status': status, 'mrr': usd(mrr), 'interval': interval, 'intervalCount': 1, 'startedAt': started}
        if ended:
            e['canceledAt'] = ended
            e['endedAt'] = ended
        stripe.append(e)

    # QuickBooks: invoices and their payments (customers pay by ACH into checking), and one bill.
    def inv(ext, number, who, issue, due, total, paid, status, direction='receivable'):
        return {'type': 'invoice.upsert', 'externalId': ext, 'connectionId': '$conn', 'direction': direction, 'number': number, 'counterparty': who, 'issueDate': issue, 'dueDate': due, 'total': usd(total), 'amountPaid': usd(paid), 'status': status}

    qbo.append(inv('inv1001', 'INV-1001', 'Northwind Traders', '2026-06-01', '2026-07-01', 1_200_000, 1_200_000, 'paid'))
    qbo.append(inv('inv1002', 'INV-1002', 'Initech', '2026-08-01', '2026-08-31', 800_000, 300_000, 'partially_paid'))
    qbo.append(inv('inv1003', 'INV-1003', 'Globex', '2026-09-15', '2026-10-15', 450_000, 0, 'open'))
    qbo.append(inv('inv1004', 'INV-1004', 'Hooli', '2026-07-10', '2026-08-09', 220_000, 0, 'open'))
    qbo.append(inv('bill77', 'B-77', 'Harbor Packaging', '2026-10-01', '2026-10-20', 180_000, 0, 'open', direction='payable'))
    qbo.append({'type': 'payment.applied', 'externalId': 'pay1001', 'connectionId': '$conn', 'direction': 'receivable', 'date': '2026-06-28', 'amount': usd(1_200_000), 'counterparty': 'Northwind Traders', 'applications': [{'invoiceExternalId': 'inv1001', 'amount': usd(1_200_000)}], 'reference': 'INV-1001'})
    qbo.append({'type': 'payment.applied', 'externalId': 'pay1002', 'connectionId': '$conn', 'direction': 'receivable', 'date': '2026-09-05', 'amount': usd(300_000), 'counterparty': 'Initech', 'applications': [{'invoiceExternalId': 'inv1002', 'amount': usd(300_000)}], 'reference': 'INV-1002'})
    bank.append(txn('dep_inv1001', 'chk', '2026-06-28', 1_200_000, 'Northwind Traders', rawText='NORTHWIND TRADERS ACH INV-1001'))
    bank.append(txn('dep_inv1002', 'chk', '2026-09-05', 300_000, 'Initech', rawText='INITECH ACH INV-1002 PART'))

    # The SAFE money and the founder's loan.
    bank.append(txn('safe_wire', 'chk', '2026-09-10', 25_000_000, 'Acorn Ventures', rawText='WIRE IN ACORN VENTURES SAFE'))
    bank.append(txn('founder_loan', 'chk', '2026-05-02', 2_000_000, 'Jordan Rivera', rawText='ONLINE TRANSFER FROM J RIVERA'))

    # Balances on Oct 11: checking = opening + every checking row; the card owes nothing (paid off on the 25th, no later rows).
    chk_rows = sum(e['amount']['minor'] for e in bank if e['type'] == 'txn.upsert' and e['accountExternalId'] == 'chk')
    card_rows = sum(e['amount']['minor'] for e in card)
    bank.append({'type': 'balance.snapshot', 'externalId': 'chk_now', 'connectionId': '$conn', 'accountExternalId': 'chk', 'at': SNAPSHOT_AT, 'current': usd(OPENING_CHECKING + chk_rows)})
    bank.append({'type': 'balance.snapshot', 'externalId': 'card_now', 'connectionId': '$conn', 'accountExternalId': 'card', 'at': SNAPSHOT_AT, 'current': usd(card_rows)})

    fixture = {
        'scenario': 's2-founder',
        'now': NOW,
        'timeZone': 'UTC',
        'company': 'Lumen Labs',
        'openingBalances': {'chk': OPENING_CHECKING, 'card': 0, 'stripe_bal': 0},
        'connections': [
            {'id': 'bank', 'key': 'plaid', 'name': 'Mercury', 'entity': 'Lumen Labs', 'events': bank + card},
            {'id': 'stripe', 'key': 'stripe', 'name': 'Stripe', 'entity': 'Lumen Labs', 'events': stripe},
            {'id': 'qbo', 'key': 'quickbooks', 'name': 'QuickBooks', 'entity': 'Lumen Labs', 'events': qbo},
        ],
        # What the founder does in the app after the first sync, in order.
        'actions': [
            {'do': 'record_equity_event', 'args': {'company': 'Lumen Labs', 'kind': 'issuance', 'date': '2025-11-01', 'stakeholder': 'Jordan Rivera', 'shares': 8_000_000, 'share_class': 'Common', 'idempotency_key': 's2-eq-0001'}},
            {'do': 'record_equity_event', 'args': {'company': 'Lumen Labs', 'kind': 'option_grant', 'date': '2026-06-01', 'stakeholder': 'First engineer', 'shares': 400_000, 'vesting': {'start': '2026-06-01', 'months': 48, 'cliff_months': 12}, 'idempotency_key': 's2-eq-0002'}},
            {'do': 'record_equity_event', 'args': {'company': 'Lumen Labs', 'kind': 'safe', 'date': '2026-09-10', 'stakeholder': 'Acorn Ventures', 'amount': {'amount': '250000.00', 'currency': 'USD'}, 'valuation_cap': {'amount': '10000000.00', 'currency': 'USD'}, 'idempotency_key': 's2-eq-0003'}},
            # Review: every suggested match is confirmed (the SAFE wire is the recorded SAFE's money); the founder's transfer is a loan.
            {'do': 'confirm_all_matches'},
            {'do': 'answer_money', 'externalId': 'founder_loan', 'kind': 'owner_loan'},
        ],
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(fixture, f, indent=1, sort_keys=False)
        f.write('\n')
    print(f'wrote {os.path.normpath(OUT)}: {sum(len(c["events"]) for c in fixture["connections"])} events, {len(fixture["actions"])} actions')


if __name__ == '__main__':
    sys.exit(main())
