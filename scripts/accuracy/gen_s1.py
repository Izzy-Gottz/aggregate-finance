#!/usr/bin/env python3
"""S1 Individual: writes apps/server/src/accuracy/s1-individual/fixture.json (see gen_s2.py for the shape).

Sam Lee, a Personal space only, Apr-Sep 2026, as seen on 2026-10-12:
- Chase checking (salary twice a month, rent, utilities, a car-loan payment, card payments, a monthly move to savings)
  and savings (interest)
- two Chase cards: Sapphire (groceries, flights, an Amazon order refunded in August, a late-September purchase) and
  Freedom (subscriptions, a pending charge on Sep 30)
- a Fidelity brokerage with holdings, a Coinbase account with BTC and ETH, and a Toyota car loan with its terms
"""
import json
import os
import sys

OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'apps', 'server', 'src', 'accuracy', 's1-individual', 'fixture.json')
MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']
NOW = '2026-10-12T16:00:00Z'
AT = '2026-10-11T08:00:00Z'
OPENING = {'chk': 800_000, 'sav': 2_500_000}


def usd(minor):
    return {'minor': minor, 'currency': 'USD'}


def main():
    chase, fidelity, coinbase, toyota = [], [], [], []

    def acct(lst, ext, name, typ, mask, **extra):
        e = {'type': 'account.upsert', 'externalId': ext, 'connectionId': '$conn', 'name': name, 'accountType': typ, 'currency': 'USD', 'mask': mask, 'businessHint': 'personal'}
        e.update(extra)
        lst.append(e)

    def txn(lst, ext, a, date, minor, desc, **extra):
        e = {'type': 'txn.upsert', 'externalId': ext, 'connectionId': '$conn', 'accountExternalId': a, 'date': date, 'amount': usd(minor), 'status': 'posted', 'counterparty': desc, 'rawText': desc.upper()}
        e.update(extra)
        lst.append(e)

    acct(chase, 'chk', 'Chase Checking', 'depository', '1101', institution='Chase')
    acct(chase, 'sav', 'Chase Savings', 'depository', '1102', institution='Chase')
    acct(chase, 'sapphire', 'Sapphire Preferred', 'credit_card', '4401', institution='Chase',
         liability={'kind': 'credit', 'apr': '24.99', 'minimumPayment': usd(4_000), 'nextPaymentDueDate': '2026-10-20', 'lastStatementBalance': usd(9_510), 'lastStatementDate': '2026-09-28'})
    acct(chase, 'freedom', 'Freedom Unlimited', 'credit_card', '4402', institution='Chase')

    for mi, m in enumerate(MONTHS):
        for d in ('01', '15'):
            txn(chase, f'salary_{m}_{d}', 'chk', f'{m}-{d}', 425_000, 'Acme Corp Payroll', rawText='ACME CORP PAYROLL DIRECT DEP', categoryHint='INCOME_WAGES')
        txn(chase, f'rent_{m}', 'chk', f'{m}-01', -240_000, 'Maple Apartments', categoryHint='RENT_AND_UTILITIES_RENT')
        txn(chase, f'power_{m}', 'chk', f'{m}-06', -(14_237 + mi * 311), 'City Power and Light', categoryHint='RENT_AND_UTILITIES_GAS_AND_ELECTRICITY')
        txn(chase, f'save_out_{m}', 'chk', f'{m}-16', -50_000, 'Transfer to Savings', linkRefs={'transfer': f'sv_{m}'})
        txn(chase, f'save_in_{m}', 'sav', f'{m}-16', 50_000, 'Transfer from Checking', linkRefs={'transfer': f'sv_{m}'})
        txn(chase, f'interest_{m}', 'sav', f'{m}-28', 312 + mi * 9, 'Interest Payment', categoryHint='INCOME_INTEREST_EARNED')
        # The car loan: paid from checking, received by the loan account (one move between own accounts).
        txn(chase, f'toyota_out_{m}', 'chk', f'{m}-10', -45_000, 'Toyota Financial Services', linkRefs={'transfer': f'ty_{m}'})
        txn(toyota, f'toyota_in_{m}', 'loan', f'{m}-10', 45_000, 'Payment Received', linkRefs={'transfer': f'ty_{m}'})

        sapphire = [(5, 'Whole Foods Market', 18_640, 'FOOD_AND_DRINK_GROCERIES'), (12, 'Whole Foods Market', 20_115, 'FOOD_AND_DRINK_GROCERIES')]
        if m == '2026-07':
            sapphire.append((3, 'Delta Air Lines', 38_900, 'TRAVEL_FLIGHTS'))
        if m == '2026-08':
            sapphire.append((8, 'Amazon', 12_999, None))
        freedom = [(3, 'Netflix', 1_549, 'ENTERTAINMENT_TV_AND_MOVIES'), (9, 'Uber', 2_380 + mi * 105, 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES'), (11, 'Starbucks', 675, 'FOOD_AND_DRINK_COFFEE')]
        owed = {'sapphire': 0, 'freedom': 0}
        for card, rows in (('sapphire', sapphire), ('freedom', freedom)):
            for day, who, amt, hint in rows:
                extra = {'categoryHint': hint} if hint else {}
                txn(chase, f'{card}_{m}_{day}_{who[:4].lower()}', card, f'{m}-{day:02d}', -amt, who, **extra)
                owed[card] += amt
        if m == '2026-08':
            # Amazon refunds the order in full; the card shows money in with no category.
            txn(chase, 'amazon_refund', 'sapphire', '2026-08-14', 12_999, 'Amazon', rawText='AMAZON MKTPLACE REFUND')
            owed['sapphire'] -= 12_999
        for card in ('sapphire', 'freedom'):
            txn(chase, f'{card}_pay_out_{m}', 'chk', f'{m}-20', -owed[card], f'Chase Card Payment {card.title()}', linkRefs={'card_payment': f'{card}_{m}'})
            txn(chase, f'{card}_pay_in_{m}', card, f'{m}-20', owed[card], 'Payment Thank You', linkRefs={'card_payment': f'{card}_{m}'})

    # After the September payments: one purchase posted, one still pending.
    txn(chase, 'sapphire_late', 'sapphire', '2026-09-25', -9_510, 'Whole Foods Market', categoryHint='FOOD_AND_DRINK_GROCERIES')
    txn(chase, 'freedom_pending', 'freedom', '2026-09-30', -6_420, 'Shell', status='pending', categoryHint='TRANSPORTATION_GAS')

    rows = [e for e in chase if e['type'] == 'txn.upsert' and e['status'] == 'posted']
    bal = {a: sum(e['amount']['minor'] for e in rows if e['accountExternalId'] == a) for a in ('chk', 'sav', 'sapphire', 'freedom')}
    pending_freedom = -6_420
    for a, current in (('chk', OPENING['chk'] + bal['chk']), ('sav', OPENING['sav'] + bal['sav']), ('sapphire', bal['sapphire']), ('freedom', bal['freedom'] + pending_freedom)):
        chase.append({'type': 'balance.snapshot', 'externalId': f'{a}_now', 'connectionId': '$conn', 'accountExternalId': a, 'at': AT, 'current': usd(current)})

    acct(fidelity, 'brk', 'Fidelity Brokerage', 'investment', '7781', institution='Fidelity')
    holdings = [('VTI', 'Vanguard Total Stock Market ETF', '120', 3_348_000, 2_800_000), ('AAPL', 'Apple Inc.', '40', 913_044, 650_000), ('SPAXX', 'Fidelity Government Money Market', '9700', 970_000, 970_000)]
    fidelity.append({'type': 'balance.snapshot', 'externalId': 'brk_now', 'connectionId': '$conn', 'accountExternalId': 'brk', 'at': AT, 'current': usd(sum(h[3] for h in holdings)),
                     'holdings': [{'securityExternalId': f'sec_{t}', 'ticker': t, 'name': n, 'quantity': q, 'value': usd(v), 'costBasis': usd(c)} for t, n, q, v, c in holdings]})

    acct(coinbase, 'cb', 'Coinbase', 'crypto', '0001', institution='Coinbase')
    coins = [('BTC', 'Bitcoin', '0.25', 1_565_000, 900_000), ('ETH', 'Ethereum', '2.1', 661_500, 520_000)]
    coinbase.append({'type': 'balance.snapshot', 'externalId': 'cb_now', 'connectionId': '$conn', 'accountExternalId': 'cb', 'at': AT, 'current': usd(sum(c[3] for c in coins)),
                     'holdings': [{'securityExternalId': f'coin_{t}', 'ticker': t, 'name': n, 'quantity': q, 'value': usd(v), 'costBasis': usd(c)} for t, n, q, v, c in coins]})

    acct(toyota, 'loan', 'Toyota Auto Loan', 'loan', '9310', institution='Toyota Financial Services',
         liability={'kind': 'other', 'apr': '6.9', 'minimumPayment': usd(45_000), 'nextPaymentDueDate': '2026-10-10', 'originationPrincipal': usd(2_400_000), 'maturityDate': '2029-03-10'})
    toyota.append({'type': 'balance.snapshot', 'externalId': 'loan_now', 'connectionId': '$conn', 'accountExternalId': 'loan', 'at': AT, 'current': usd(-1_845_000)})

    fixture = {
        'scenario': 's1-individual',
        'now': NOW,
        'timeZone': 'UTC',
        'company': None,
        'person': 'Sam Lee',
        'openingBalances': OPENING,
        'connections': [
            {'id': 'chase', 'key': 'plaid', 'name': 'Chase', 'entity': 'Personal', 'events': chase},
            {'id': 'fidelity', 'key': 'plaid', 'name': 'Fidelity', 'entity': 'Personal', 'events': fidelity},
            {'id': 'coinbase', 'key': 'plaid', 'name': 'Coinbase', 'entity': 'Personal', 'events': coinbase},
            {'id': 'toyota', 'key': 'plaid', 'name': 'Toyota Financial', 'entity': 'Personal', 'events': toyota},
        ],
        'actions': [
            {'do': 'confirm_all_matches'},
            # The Amazon money back is a refund of that order (asked only if the bank's category didn't say so).
            {'do': 'answer_money', 'externalId': 'amazon_refund', 'kind': 'refund', 'ifAsked': True},
        ],
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(fixture, f, indent=1)
        f.write('\n')
    print(f'wrote {os.path.normpath(OUT)}: {sum(len(c["events"]) for c in fixture["connections"])} events')


if __name__ == '__main__':
    sys.exit(main())
