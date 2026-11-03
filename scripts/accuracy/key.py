#!/usr/bin/env python3
"""Answer keys for the accuracy scenarios, computed from each fixture.json alone.

Never imports or calls Aggregate code: the answers come from the raw provider data, the founder's actions and the
written definitions (docs/guides/definitions.md, docs/accuracy/README.md). Output: key.json next to the fixture, in
the benchmark's questions.json shape (id, category, question, answer, tolerance, as_of, notes, app) plus `check`
(the MCP tool, its arguments and the field the suite compares) and the fixture's sha256.

  python3 scripts/accuracy/key.py s2-founder
"""
import hashlib
import json
import os
import sys
from collections import defaultdict
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

ROOT = os.path.join(os.path.dirname(__file__), '..', '..', 'apps', 'server', 'src', 'accuracy')


def money(minor):
    sign = '-' if minor < 0 else ''
    m = abs(minor)
    return f'{sign}{m // 100}.{m % 100:02d}'


def day_of(e):
    return (e.get('date') or e.get('at'))[:10]


def month_range(ym):
    y, m = int(ym[:4]), int(ym[5:7])
    start = date(y, m, 1)
    nxt = date(y + (m == 12), m % 12 + 1, 1)
    return start.isoformat(), (nxt - timedelta(days=1)).isoformat()


def trailing_months(today, n):
    y, m = today.year, today.month
    out = []
    for i in range(n, 0, -1):
        mm = m - i
        yy = y + (mm - 1) // 12
        mm = (mm - 1) % 12 + 1
        out.append(f'{yy}-{mm:02d}')
    return out


class Q:
    """Collects questions; each answer is computed above it from the fixture, never read back from Aggregate."""

    def __init__(self, scenario, as_of):
        self.scenario, self.as_of, self.rows = scenario, as_of, []

    def add(self, qid, category, question, kind, value, check, notes, app=False, tol=None, known_issue=None):
        if kind == 'money':
            answer = {'type': 'money', 'value': money(value), 'currency': 'USD'}
            tolerance = {'abs': 0.01}
        elif kind == 'number':
            answer = {'type': 'number', 'value': value}
            tolerance = {'abs': tol if tol is not None else 0.05}
        elif kind == 'count':
            answer = {'type': 'count', 'value': value}
            tolerance = {'abs': 0}
        else:
            answer = {'type': 'text', 'value': value}
            tolerance = None
        row = {'id': f'{self.scenario}-{qid}', 'category': category, 'question': question, 'answer': answer, 'tolerance': tolerance, 'as_of': self.as_of, 'notes': notes, 'check': check}
        if app:
            row['app'] = True
        if known_issue:
            row['known_issue'] = known_issue
        self.rows.append(row)


def s2(fx):
    co = fx['company']
    today = date.fromisoformat(fx['now'][:10])
    conns = {c['id']: c['events'] for c in fx['connections']}
    bank = conns['bank']
    stripe = conns['stripe']
    qbo = conns['qbo']
    txns = [e for e in bank if e['type'] == 'txn.upsert']
    snaps = {e['accountExternalId']: e['current']['minor'] for c in conns.values() for e in c if e['type'] == 'balance.snapshot'}
    actions = fx['actions']
    loan_ids = {a['externalId'] for a in actions if a['do'] == 'answer_money' and a['kind'] == 'owner_loan'}
    # Money in that is a recorded SAFE (same amount, same day) is financing, not sales.
    safes_in = [(a['args']['date'], int(Decimal(a['args']['amount']['amount']) * 100)) for a in actions if a['do'] == 'record_equity_event' and a['args']['kind'] == 'safe']
    equity_ids = {t['externalId'] for t in txns if (t['date'], t['amount']['minor']) in safes_in}

    # What each row is, by the definitions (after Review is cleared as the actions say).
    paid_invoice_deposits = {}
    for p in (e for e in qbo if e['type'] == 'payment.applied'):
        # The bank deposit of the same amount and date is that payment (the founder confirms the match).
        dep = next(t for t in txns if t['accountExternalId'] == 'chk' and t['amount']['minor'] == p['amount']['minor'] and t['date'] == p['date'])
        paid_invoice_deposits[dep['externalId']] = p

    def is_transfer(t):
        return 'linkRefs' in t and 'card_payment' in t['linkRefs'] or t['counterparty'] == 'Stripe Transfer'

    expenses = []  # (date, minor > 0, what)
    revenue = []   # (date, minor > 0, what)
    refunds = []   # (date, minor > 0)
    for t in txns:
        a = t['amount']['minor']
        if is_transfer(t) or t['externalId'] in loan_ids or t['externalId'] in equity_ids:
            continue
        if a < 0:
            expenses.append((t['date'], -a, t['counterparty']))
        elif t['externalId'] in paid_invoice_deposits:
            revenue.append((t['date'], a, 'invoice payment'))
        else:
            raise SystemExit(f'unexplained money in: {t["externalId"]}')
    for e in stripe:
        if e['type'] != 'processor.balance_txn':
            continue
        d = day_of(e)
        if e['kind'] == 'charge':
            revenue.append((d, e['gross']['minor'], 'stripe charge'))
            expenses.append((d, e['fee']['minor'], 'Stripe fees'))
        elif e['kind'] == 'refund':
            refunds.append((d, -e['gross']['minor']))

    def total(rows, frm, to, what=None):
        return sum(r[1] for r in rows if frm <= r[0] <= to and (what is None or r[2] == what))

    def period(frm, to):
        exp, rev, ref = total(expenses, frm, to), total(revenue, frm, to), total(refunds, frm, to)
        return exp, rev, ref

    q = Q(fx['scenario'], fx['now'])
    m3 = trailing_months(today, 3)
    w_from, w_to = month_range(m3[0])[0], month_range(m3[-1])[1]
    earliest = min(min(t['date'] for t in txns), min(day_of(e) for e in stripe if e['type'] == 'processor.balance_txn'))
    covered = sum(1 for ym in m3 if earliest <= month_range(ym)[1])
    exp3, rev3, ref3 = period(w_from, w_to)
    gross_avg = Decimal(exp3 + ref3) / covered
    net_avg = Decimal(exp3 + ref3 - rev3) / covered
    r0 = lambda d: int(d.quantize(Decimal('1'), rounding=ROUND_HALF_UP))

    cash = snaps['chk'] + snaps['stripe_bal']
    card_owed = -snaps['card']
    metric = lambda name, **extra: {'tool': 'get_metric', 'args': {'metric': name, 'company': co, **extra}, 'path': 'value'}

    # ---- balances ----
    q.add('cash', 'cash', f'How much cash does {co} have?', 'money', cash, metric('cash'),
          'Cash = latest current balance of accounts counted as cash: Mercury Checking + Stripe balance (card not subtracted).', app=True)
    q.add('cash-checking', 'cash', f'What is the Mercury Checking balance?', 'money', snaps['chk'],
          {'tool': 'list_accounts', 'args': {'company': co}, 'path': 'accounts[name=Mercury Checking].balance'}, 'The bank\'s current balance on Oct 11.')
    q.add('cash-stripe', 'cash', 'How much is sitting in the Stripe balance?', 'money', snaps['stripe_bal'],
          {'tool': 'list_accounts', 'args': {'company': co}, 'path': 'accounts[name=Stripe balance].balance'}, 'Two late-September charges, net of fees, not yet paid out.')
    q.add('card-balances', 'cash', 'What is owed on the company card?', 'money', card_owed, metric('card_balances'), 'Paid off in full on Sep 25, nothing since.')
    q.add('net-cash', 'cash', f'What is {co}\'s net cash?', 'money', cash - card_owed, metric('net_cash'), 'Cash minus card balances.')

    # ---- burn and runway (last 3 full months) ----
    q.add('gross-burn', 'burn', f'What is {co}\'s average monthly gross burn?', 'money', r0(gross_avg), metric('gross_burn'),
          f'Monthly average over {w_from}..{w_to} ({covered} months): every expense (rent, AWS, payroll net + taxes, card purchases at swipe, Stripe fees) plus customer refunds. Card payments, payouts, the SAFE and the founder loan excluded.', app=True)
    q.add('net-burn', 'burn', f'What is {co}\'s average monthly net burn?', 'money', r0(net_avg), metric('net_burn'),
          'Gross burn minus revenue (Stripe charges at gross + invoice payments received), monthly average of the last 3 full months.', app=True)
    runway = (Decimal(cash) / net_avg).quantize(Decimal('0.1'), rounding=ROUND_HALF_UP)
    q.add('runway', 'runway', f'How many months of runway does {co} have?', 'number', float(runway), {'tool': 'get_metric', 'args': {'metric': 'runway', 'company': co}, 'path': 'value'},
          'Cash ÷ average monthly net burn of the last 3 full months, to one decimal.', app=True)
    q.add('overview-burn', 'burn', 'What net burn does the overview show?', 'money', r0(net_avg),
          {'tool': 'get_overview', 'args': {'company': co}, 'path': 'companies[0].net_burn_3mo'}, 'Same figure as get_metric net_burn.')
    q.add('overview-runway', 'runway', 'What runway does the overview show?', 'number', float(runway),
          {'tool': 'get_overview', 'args': {'company': co}, 'path': 'companies[0].runway_months'}, 'Same as get_metric runway.')
    q.add('overview-cash', 'cash', 'What cash does the overview show?', 'money', cash, {'tool': 'get_overview', 'args': {'company': co}, 'path': 'companies[0].cash'}, 'Same as get_metric cash.')
    for ym in m3:
        f, t = month_range(ym)
        e, r, rf = period(f, t)
        q.add(f'gross-burn-{ym}', 'burn', f'What was gross burn in {ym}?', 'money', e + rf, metric('gross_burn', **{'from': f, 'to': t}), 'One month asked: that month\'s total.')
        q.add(f'net-burn-{ym}', 'burn', f'What was net burn in {ym}?', 'money', e + rf - r, metric('net_burn', **{'from': f, 'to': t}), 'Gross burn minus revenue, that month.')
        q.add(f'revenue-{ym}', 'revenue', f'What was cash revenue in {ym}?', 'money', r - rf, metric('revenue', **{'from': f, 'to': t}),
              'Cash basis: Stripe charges at gross minus refunds, plus invoice payments received. Payouts are not revenue.', app=(ym == m3[-1]))
    qf, qt = w_from, w_to
    e, r, rf = period(qf, qt)
    q.add('gross-burn-q3', 'burn', 'Average monthly gross burn over Q3 (Jul-Sep)?', 'money', r0(Decimal(e + rf) / 3), metric('gross_burn', **{'from': qf, 'to': qt}), 'A period: its total ÷ 3 calendar months.')
    q.add('revenue-q3', 'revenue', 'Cash revenue in Q3 (Jul-Sep)?', 'money', r - rf, metric('revenue', **{'from': qf, 'to': qt}), 'Q3 total (revenue is a total, not an average).', app=True)
    q.add('stripe-fees-q3', 'fees', 'How much did Stripe take in fees in Q3?', 'money', total(expenses, qf, qt, 'Stripe fees'),
          {'tool': 'get_reports', 'args': {'kind': 'profit_and_loss', 'company': co, 'from': qf, 'to': qt, 'basis': 'cash'}, 'path': 'reports[0].sections[*].rows[account~fee].amount'}, '2.9% + 30c per charge, rounded half up.', app=True)
    q.add('refunds-aug', 'revenue', 'How much was refunded to customers in August?', 'money', total(refunds, '2026-08-01', '2026-08-31'),
          {'tool': 'get_reports', 'args': {'kind': 'profit_and_loss', 'company': co, 'from': '2026-08-01', 'to': '2026-08-31', 'basis': 'cash'}, 'path': 'reports[0].sections[*].rows[account~efund].amount', 'abs': True}, 'Initech\'s August charge, refunded in full (Stripe kept the fee).', app=True)
    q.add('pnl-q3-net', 'reports', 'Net income for Q3 on the cash basis?', 'money', r - rf - e,
          {'tool': 'get_reports', 'args': {'kind': 'profit_and_loss', 'company': co, 'from': qf, 'to': qt, 'basis': 'cash'}, 'path': 'reports[0].total'}, 'Revenue − refunds − expenses = −(net burn over the quarter).')
    pay = sum(-t['amount']['minor'] for t in txns if t['counterparty'].startswith('Gusto') and '2026-09-01' <= t['date'] <= '2026-09-30')
    q.add('payroll-sep', 'payroll', 'What did payroll cost in September?', 'money', pay, metric('payroll_cost', **{'from': '2026-09-01', 'to': '2026-09-30'}), 'Gusto net pay + payroll taxes debited from checking (two pay dates).', app=True)

    # ---- MRR ----
    subs = [e for e in stripe if e['type'] == 'subscription.upsert']
    mrr = sum(e['mrr']['minor'] for e in subs if e['status'] in ('active', 'past_due'))
    q.add('mrr', 'subscriptions', f'What is {co}\'s MRR?', 'money', mrr, metric('mrr'), 'Active subscriptions, monthly-normalized (the yearly plan ÷ 12); the canceled one is out.', app=True)
    q.add('arr', 'subscriptions', f'What is {co}\'s ARR?', 'money', mrr * 12, metric('arr'), 'MRR × 12.')

    # ---- invoices and bills ----
    invs = {e['externalId']: e for e in qbo if e['type'] == 'invoice.upsert'}
    paid = defaultdict(int)
    for p in (e for e in qbo if e['type'] == 'payment.applied'):
        for a in p['applications']:
            paid[a['invoiceExternalId']] += a['amount']['minor']
    open_ar = {k: v['total']['minor'] - paid[k] for k, v in invs.items() if v['direction'] == 'receivable' and v['total']['minor'] - paid[k] > 0}
    overdue = {k: r for k, r in open_ar.items() if invs[k]['dueDate'] < today.isoformat()}
    q.add('owed-to-you', 'invoices', f'How much do customers owe {co}?', 'money', sum(open_ar.values()), metric('ar_open'), 'Open receivables: what is left on each unpaid or partly paid invoice.', app=True)
    q.add('overdue', 'invoices', 'How much of that is overdue?', 'money', sum(overdue.values()), metric('ar_overdue'), 'Past due date and not fully paid (INV-1002\'s remainder and INV-1004).', app=True)
    q.add('overdue-count', 'invoices', 'How many invoices are overdue?', 'count', len(overdue), {'tool': 'search_invoices', 'args': {'company': co, 'status': 'overdue'}, 'path': 'owed_to_you.invoices.length'}, 'Counted per invoice.')
    q.add('partly-paid-count', 'invoices', 'How many invoices are partly paid?', 'count', sum(1 for k in open_ar if paid[k] > 0),
          {'tool': 'search_invoices', 'args': {'company': co, 'status': 'partially_paid'}, 'path': 'owed_to_you.invoices.length'}, 'INV-1002 (also overdue).')
    q.add('inv1002-left', 'invoices', 'How much is still owed on INV-1002?', 'money', open_ar['inv1002'],
          {'tool': 'search_invoices', 'args': {'company': co, 'number': 'INV-1002'}, 'path': 'owed_to_you.invoices[0].outstanding'}, '$8,000 less the $3,000 paid on Sep 5.', app=True)
    bills_due = sum(v['total']['minor'] - paid[k] for k, v in invs.items() if v['direction'] == 'payable' and today.isoformat() <= v['dueDate'] <= (today + timedelta(days=30)).isoformat())
    q.add('bills-due', 'bills', 'What bills are due in the next 30 days?', 'money', bills_due, metric('ap_due'), 'Open bills with a due date in the next 30 days (B-77).', app=True)

    # ---- owner money and equity ----
    loan = sum(t['amount']['minor'] for t in txns if t['externalId'] in loan_ids)
    q.add('owner-balance', 'owner', f'How much does {co} owe its founder?', 'money', loan, metric('owner_balance'), 'The founder\'s $20,000 transfer, answered as a loan in Review; nothing repaid.', app=True)
    eq = [a['args'] for a in actions if a['do'] == 'record_equity_event']
    fd = sum(a.get('shares', 0) for a in eq if a['kind'] in ('issuance', 'option_grant'))
    q.add('fully-diluted', 'equity', 'How many fully diluted shares?', 'count', fd, {'tool': 'get_metric', 'args': {'metric': 'fully_diluted', 'company': co}, 'path': 'value'},
          'Issued shares + granted options. The unconverted SAFE is listed separately, not counted in shares.', app=True)
    safes = sum(int(Decimal(a['amount']['amount']) * 100) for a in eq if a['kind'] == 'safe')
    q.add('safes', 'equity', 'How much has been raised on SAFEs?', 'money', safes, {'tool': 'get_cap_table', 'args': {'company': co}, 'path': 'companies[0].safes_and_notes[kind=safe].amount'}, 'Acorn Ventures, $250,000 at a $10M cap.')
    q.add('safe-not-revenue', 'revenue', 'What was September\'s cash revenue, not counting the SAFE wire?', 'money', period('2026-09-01', '2026-09-30')[1] - period('2026-09-01', '2026-09-30')[2], metric('revenue', **{'from': '2026-09-01', 'to': '2026-09-30'}),
          'September revenue excludes the $250,000 SAFE wire (financing, not sales).')
    # ---- more periods, accrual, balance sheet, upcoming ----
    for ym in ('2026-04', '2026-05', '2026-06'):
        f, t = month_range(ym)
        e, r, rf = period(f, t)
        q.add(f'revenue-{ym}', 'revenue', f'What was cash revenue in {ym}?', 'money', r - rf, metric('revenue', **{'from': f, 'to': t}), 'Cash basis: Stripe charges minus refunds plus invoice payments received.')
        q.add(f'net-burn-{ym}', 'burn', f'What was net burn in {ym}?', 'money', e + rf - r, metric('net_burn', **{'from': f, 'to': t}), 'Gross burn minus revenue, that month.')
    e, r, rf = period('2026-04-01', '2026-06-30')
    q.add('net-burn-q2', 'burn', 'Average monthly net burn over Q2 (Apr-Jun)?', 'money', r0(Decimal(e + rf - r) / 3), metric('net_burn', **{'from': '2026-04-01', 'to': '2026-06-30'}), 'Q2 total ÷ 3.')
    charges = [(day_of(x), x['gross']['minor']) for x in stripe if x['type'] == 'processor.balance_txn' and x['kind'] == 'charge']
    for ym in ('2026-08', '2026-09'):
        f, t = month_range(ym)
        accr = sum(v['total']['minor'] for v in invs.values() if v['direction'] == 'receivable' and f <= v['issueDate'] <= t) + sum(g for d, g in charges if f <= d <= t) - total(refunds, f, t)
        q.add(f'revenue-accrual-{ym}', 'revenue', f'Accrual revenue in {ym}?', 'money', accr, metric('revenue', **{'from': f, 'to': t, 'basis': 'accrual'}),
              'Accrual: invoices by issue date plus Stripe charges, minus refunds.')
    q.add('bs-assets-sep30', 'reports', 'Total assets on Sep 30 (cash basis)?', 'money', snaps['chk'] + snaps['stripe_bal'],
          {'tool': 'get_reports', 'args': {'kind': 'balance_sheet', 'company': co, 'from': '2026-09-01', 'to': '2026-09-30', 'basis': 'cash'}, 'path': 'reports[0].total'},
          'Cash basis: checking + Stripe balance (no rows after Sep 30 in either; receivables are accrual only).')
    q.add('upcoming-bill', 'bills', 'How much is the next bill due?', 'money', bills_due,
          {'tool': 'list_upcoming', 'args': {'company': co, 'days': 30}, 'path': 'items[what~Harbor].amount', 'abs': True},
          'B-77 Harbor Packaging, due Oct 20. Asked as an amount owed (the upcoming list shows it negative, as money out).')
    # Adding up the processor's rows must give what the P&L says: charges at gross, fees as their own rows.
    q3_charges = sum(g for d, g in charges if qf <= d <= qt)
    qt_ = lambda query: {'tool': 'query_transactions', 'args': {'company': co, 'from': qf, 'to': qt, 'query': query, 'measures': ['sum']}, 'path': 'totals[0].sum', 'abs': True}
    q.add('stripe-charges-q3-rows', 'revenue', 'Add up the Stripe charges in Q3 (gross).', 'money', q3_charges, qt_('in account:Stripe'),
          'Charges at gross, as the P&L counts them; the fee is a row of its own.')
    q.add('stripe-fee-rows-q3', 'fees', 'How much did Stripe charge in fees in Q3, adding up its fee rows?', 'money', total(expenses, qf, qt, 'Stripe fees'), qt_('out account:Stripe fee'),
          'Same as the P&L\'s processor fees.')
    return q



def s1(fx):
    who = 'Personal'
    today = date.fromisoformat(fx['now'][:10])
    conns = {c['id']: c['events'] for c in fx['connections']}
    allev = [e for evs in conns.values() for e in evs]
    snaps = {e['accountExternalId']: e for e in allev if e['type'] == 'balance.snapshot'}
    cur = {a: e['current']['minor'] for a, e in snaps.items()}
    txns = [e for e in allev if e['type'] == 'txn.upsert']
    posted = [t for t in txns if t['status'] == 'posted']
    q = Q(fx['scenario'], fx['now'])
    metric = lambda name, **extra: {'tool': 'get_metric', 'args': {'metric': name, 'company': who, **extra}, 'path': 'value'}
    accounts = {'tool': 'list_accounts', 'args': {'company': who}}

    def moving(t):
        refs = t.get('linkRefs') or {}
        return 'transfer' in refs or 'card_payment' in refs

    # Spending lowers by a refund of it; income is wages and interest (the bank's categories say so).
    spend, income = [], []
    for t in posted:
        if moving(t):
            continue
        a = t['amount']['minor']
        hint = t.get('categoryHint') or ''
        if a < 0:
            spend.append((t['date'], -a))
        elif hint in ('INCOME_WAGES', 'INCOME_INTEREST_EARNED'):
            income.append((t['date'], a, hint))
        else:
            spend.append((t['date'], -a))  # the Amazon refund: money back on that spending
    tot = lambda rows, f, t: sum(r[1] for r in rows if f <= r[0] <= t)

    cash = cur['chk'] + cur['sav']
    cards = -(cur['sapphire'] + cur['freedom'])
    q.add('cash', 'cash', 'How much cash is in the Personal space?', 'money', cash, metric('cash'), 'Checking + savings. The brokerage and Coinbase are investments, not cash.', app=True)
    q.add('checking', 'cash', 'Checking balance?', 'money', cur['chk'], {**accounts, 'path': 'accounts[name=Chase Checking].balance'}, 'Bank current balance on Oct 11.')
    q.add('savings', 'cash', 'Savings balance?', 'money', cur['sav'], {**accounts, 'path': 'accounts[name=Chase Savings].balance'}, 'Including six monthly interest payments.')
    q.add('card-debt', 'cards', 'How much is owed on credit cards?', 'money', cards, metric('card_balances'), 'Sapphire (a late-September purchase) + Freedom (a pending Shell charge the bank already counts).', app=True)
    q.add('sapphire', 'cards', 'What is owed on the Sapphire card?', 'money', -cur['sapphire'], {**accounts, 'path': 'accounts[name=Sapphire Preferred].balance', 'abs': True}, 'One purchase after the Sep 20 payment.')
    q.add('freedom', 'cards', 'What is owed on the Freedom card?', 'money', -cur['freedom'], {**accounts, 'path': 'accounts[name=Freedom Unlimited].balance', 'abs': True}, 'The pending Shell charge, as the bank states the balance.')
    q.add('net-cash', 'cash', 'Cash minus card debt?', 'money', cash - cards, metric('net_cash'), 'Cash − card balances.')
    q.add('overview-cash', 'cash', 'Cash on the overview?', 'money', cash, {'tool': 'get_overview', 'args': {'company': who}, 'path': 'companies[0].cash'}, 'Same as get_metric cash.')
    q.add('overview-cards', 'cards', 'Card debt on the overview?', 'money', cards, {'tool': 'get_overview', 'args': {'company': who}, 'path': 'companies[0].card_debt'}, 'Same as card_balances.')

    # Investments, crypto, the car loan.
    brk = snaps['brk']
    holds = {h['ticker']: h for h in brk['holdings']}
    coins = {h['ticker']: h for h in snaps['cb']['holdings']}
    hold = {'tool': 'get_holdings', 'args': {'company': who}}
    q.add('brokerage', 'investments', 'What is the Fidelity brokerage worth?', 'money', cur['brk'], {**accounts, 'path': 'accounts[name=Fidelity Brokerage].balance'}, 'The broker\'s total: VTI + AAPL + the money market.', app=True)
    q.add('vti-value', 'investments', 'What is the VTI position worth?', 'money', holds['VTI']['value']['minor'], {**hold, 'path': 'accounts[*].positions[ticker=VTI].value'}, 'As the broker reported it on Oct 11.')
    q.add('vti-qty', 'investments', 'How many VTI shares?', 'number', float(holds['VTI']['quantity']), {**hold, 'path': 'accounts[*].positions[ticker=VTI].quantity'}, 'Units held.', tol=0)
    q.add('aapl-cost', 'investments', 'What is the cost basis of the Apple shares?', 'money', holds['AAPL']['costBasis']['minor'], {**hold, 'path': 'accounts[*].positions[ticker=AAPL].cost_basis'}, 'As the broker reported it.')
    q.add('crypto', 'investments', 'What is the Coinbase account worth?', 'money', cur['cb'], {**accounts, 'path': 'accounts[name=Coinbase].balance'}, 'BTC + ETH at the reported values; not cash.', app=True)
    q.add('btc-qty', 'investments', 'How much bitcoin is held in the Personal space?', 'number', float(coins['BTC']['quantity']), {**hold, 'path': 'accounts[*].positions[ticker=BTC].quantity'}, 'Units held.', tol=0, app=True)
    q.add('eth-value', 'investments', 'What is the ETH worth?', 'money', coins['ETH']['value']['minor'], {**hold, 'path': 'accounts[*].positions[ticker=ETH].value'}, 'As Coinbase reported it.')
    q.add('loan', 'loans', 'How much is left on the car loan?', 'money', -cur['loan'], {**accounts, 'path': 'accounts[name=Toyota Auto Loan].balance', 'abs': True}, 'The lender\'s balance on Oct 11.', app=True)
    loan_terms = next(e for e in allev if e['type'] == 'account.upsert' and e['externalId'] == 'loan')['liability']
    sapph_terms = next(e for e in allev if e['type'] == 'account.upsert' and e['externalId'] == 'sapphire')['liability']
    liab = {'tool': 'get_liabilities', 'args': {'company': who}}
    q.add('loan-payment', 'loans', 'What is the monthly car payment?', 'money', loan_terms['minimumPayment']['minor'], {**liab, 'path': 'liabilities[account=Toyota Auto Loan].minimum_payment'}, 'The lender\'s minimum payment.')
    q.add('sapphire-apr', 'cards', 'What APR does the Sapphire card charge?', 'number', float(sapph_terms['apr']), {**liab, 'path': 'liabilities[account=Sapphire Preferred].apr'}, 'As the bank reported it.', tol=0, app=True)
    nw = cash + cur['brk'] + cur['cb'] - cards + cur['loan']
    q.add('net-worth', 'net worth', 'What is the net worth of the Personal space?', 'money', nw, None, 'Cash + brokerage + crypto − card debt − car loan. No single tool: asked through the apps only.', app=True)

    # Spending and income, last 3 full months.
    m3 = trailing_months(today, 3)
    f3, t3 = month_range(m3[0])[0], month_range(m3[-1])[1]
    gross3, inc3 = tot(spend, f3, t3), tot(income, f3, t3)
    r0 = lambda d: int(d.quantize(Decimal('1'), rounding=ROUND_HALF_UP))
    q.add('gross-burn', 'spending', 'Average monthly spending (last 3 full months)?', 'money', r0(Decimal(gross3) / 3), metric('gross_burn'),
          'Every purchase and bill (card purchases at swipe), less refunds; transfers to savings, card payments and car-loan payments excluded; the pending charge not yet.', app=True)
    q.add('net-burn', 'spending', 'Average monthly net burn?', 'money', r0(Decimal(gross3 - inc3) / 3), metric('net_burn'), 'Spending minus wages and interest: negative, more comes in than goes out.')
    q.add('runway-state', 'spending', 'Is the Personal space burning cash or not? Answer burning or not_burning.', 'text', 'not_burning', {'tool': 'get_metric', 'args': {'metric': 'runway', 'company': who}, 'path': 'state'}, 'Income exceeds spending.')
    for ym in m3:
        f, t = month_range(ym)
        q.add(f'spend-{ym}', 'spending', f'Spending in {ym}?', 'money', tot(spend, f, t), metric('gross_burn', **{'from': f, 'to': t}),
              {'2026-08': 'Includes the Amazon order and its full refund (net zero).', '2026-09': 'The pending Shell charge on Sep 30 is not counted.'}.get(ym, 'Purchases and bills.'), app=(ym == '2026-08'))
        q.add(f'net-{ym}', 'spending', f'Net burn in {ym}?', 'money', tot(spend, f, t) - tot(income, f, t), metric('net_burn', **{'from': f, 'to': t}), 'Spending − income.')
    interest = sum(r[1] for r in income if f3 <= r[0] <= t3 and r[2] == 'INCOME_INTEREST_EARNED')
    q.add('interest-q3', 'income', 'Savings interest earned in Q3?', 'money', interest,
          {'tool': 'get_reports', 'args': {'kind': 'profit_and_loss', 'company': who, 'from': f3, 'to': t3, 'basis': 'cash'}, 'path': 'reports[0].sections[*].rows[account~interest].amount', 'abs': True}, 'Three monthly interest payments.')
    q.add('pnl-q3', 'income', 'Q3 income minus spending on the cash-basis P&L (posted transactions only)?', 'money', inc3 - gross3,
          {'tool': 'get_reports', 'args': {'kind': 'profit_and_loss', 'company': who, 'from': f3, 'to': t3, 'basis': 'cash'}, 'path': 'reports[0].total'},
          'Wages + interest − spending, posted rows only: the $64.20 Shell charge still pending on Sep 30 is not in it.', app=True)
    groceries = sum(-t['amount']['minor'] for t in posted if t.get('categoryHint') == 'FOOD_AND_DRINK_GROCERIES' and '2026-09-01' <= t['date'] <= '2026-09-30')
    q.add('groceries-sep', 'spending', 'Groceries in September?', 'money', groceries,
          {'tool': 'query_transactions', 'args': {'company': who, 'from': '2026-09-01', 'to': '2026-09-30', 'query': 'Whole Foods', 'measures': ['sum']}, 'path': 'totals[0].sum', 'abs': True},
          'Whole Foods: two shops before the payment and one on Sep 25.', app=True)

    for ym in ('2026-04', '2026-05', '2026-06'):
        f, t = month_range(ym)
        q.add(f'spend-{ym}', 'spending', f'Spending in {ym}?', 'money', tot(spend, f, t), metric('gross_burn', **{'from': f, 'to': t}), 'Purchases and bills.')
    for ym in ('2026-07', '2026-09'):
        f, t = month_range(ym)
        uber = sum(-x['amount']['minor'] for x in posted if x['counterparty'] == 'Uber' and f <= x['date'] <= t)
        q.add(f'uber-{ym}', 'spending', f'How much did Uber rides cost in {ym}?', 'money', uber,
              {'tool': 'query_transactions', 'args': {'company': who, 'from': f, 'to': t, 'query': 'Uber', 'measures': ['sum']}, 'path': 'totals[0].sum', 'abs': True}, 'One ride a month, a little more each month.')
    power = sum(-x['amount']['minor'] for x in posted if x['counterparty'] == 'City Power and Light' and f3 <= x['date'] <= t3)
    q.add('power-q3', 'spending', 'Electricity in Q3?', 'money', power,
          {'tool': 'query_transactions', 'args': {'company': who, 'from': f3, 'to': t3, 'query': 'City Power', 'measures': ['sum']}, 'path': 'totals[0].sum', 'abs': True}, 'Three monthly bills.')
    q.add('aapl-value', 'investments', 'What are the Apple shares worth?', 'money', holds['AAPL']['value']['minor'], {**hold, 'path': 'accounts[*].positions[ticker=AAPL].value'}, 'As the broker reported it.')
    q.add('spaxx-value', 'investments', 'How much is in the money market fund?', 'money', holds['SPAXX']['value']['minor'], {**hold, 'path': 'accounts[*].positions[ticker=SPAXX].value'}, 'Cash inside the brokerage, but an investment account: not counted as cash.')
    q.add('eth-qty', 'investments', 'How much ETH?', 'number', float(coins['ETH']['quantity']), {**hold, 'path': 'accounts[*].positions[ticker=ETH].quantity'}, 'Units held.', tol=0)
    cost = sum(h['costBasis']['minor'] for h in brk['holdings'])
    q.add('brokerage-cost', 'investments', 'Total cost basis in the brokerage?', 'money', cost, {**hold, 'path': 'accounts[account=Fidelity Brokerage].positions[*].cost_basis'}, 'Sum of the reported cost basis.')
    q.add('loan-apr', 'loans', 'What rate is the car loan?', 'number', float(loan_terms['apr']), {**liab, 'path': 'liabilities[account=Toyota Auto Loan].apr'}, 'As the lender reported it.', tol=0)
    q.add('loan-principal', 'loans', 'How much was originally borrowed for the car?', 'money', loan_terms['originationPrincipal']['minor'], {**liab, 'path': 'liabilities[account=Toyota Auto Loan].original_principal'}, 'As the lender reported it.')
    q.add('loan-maturity', 'loans', 'When is the car loan paid off?', 'text', loan_terms['maturityDate'], {**liab, 'path': 'liabilities[account=Toyota Auto Loan].maturity_date'}, 'Maturity date.')
    q.add('sapphire-min', 'cards', 'Minimum payment due on the Sapphire card?', 'money', sapph_terms['minimumPayment']['minor'], {**liab, 'path': 'liabilities[account=Sapphire Preferred].minimum_payment'}, 'As the bank reported it.')
    rec = {'tool': 'list_recurring', 'args': {'company': who}}
    q.add('netflix', 'recurring', 'How much is the Netflix subscription?', 'money', 1_549, {**rec, 'path': 'recurring[counterparty~Netflix].monthly'}, 'Six monthly charges of $15.49: an active monthly series.', app=True)
    q.add('rent', 'recurring', 'What is the monthly rent?', 'money', 240_000, {**rec, 'path': 'recurring[counterparty~Maple].monthly'}, 'Six monthly payments.')
    q.add('overview-net-burn', 'spending', 'Net burn on the overview?', 'money', r0(Decimal(gross3 - inc3) / 3), {'tool': 'get_overview', 'args': {'company': who}, 'path': 'companies[0].net_burn_3mo'}, 'Same as get_metric net_burn.')
    wages = sum(r[1] for r in income if f3 <= r[0] <= t3 and r[2] == 'INCOME_WAGES')
    q.add('wages-q3', 'income', 'Wages in Q3?', 'money', wages, {'tool': 'get_reports', 'args': {'kind': 'profit_and_loss', 'company': who, 'from': f3, 'to': t3, 'basis': 'cash'}, 'path': 'reports[0].sections[*].rows[account~wages].amount', 'abs': True},
          'Six paychecks of $4,250.')
    q.add('wages-q3-category', 'income', 'Wages in Q3, added up by category?', 'money', wages,
          {'tool': 'query_transactions', 'args': {'company': who, 'from': f3, 'to': t3, 'group_by': ['category'], 'measures': ['sum']}, 'path': 'groups[category=wages_income].sum'},
          'The paychecks\' category is wages, the same as the P&L (not other income).')
    return q


# MCP company "all" also counts Personal when the key covers it; core and the parameter say every company (sent to 8a).


def s3(fx):
    today = date.fromisoformat(fx['now'][:10])
    # The fixture's own rates, or another table (--rates: e.g. staging's) to key the same data at those rates.
    rates = {(r['date'], r['from'], r['to']): Decimal(r['rate']) for r in (RATES_OVERRIDE or fx['rates'])}

    def rate_on(day):
        # As the engine does: the day's rate, else the closest earlier one within 7 days (weekends, holidays).
        d = date.fromisoformat(day)
        for back in range(8):
            r = rates.get(((d - timedelta(days=back)).isoformat(), 'EUR', 'USD'))
            if r is not None:
                return r
        raise SystemExit(f'no EUR->USD rate on or within 7 days before {day}')

    def to_usd(minor_eur, day):
        # One day's total at that day's rate, rounded half away from zero (as the definitions say: per day, then add).
        v = Decimal(minor_eur) * rate_on(day)
        return int(v.quantize(Decimal('1'), rounding=ROUND_HALF_UP)) if v >= 0 else -int((-v).quantize(Decimal('1'), rounding=ROUND_HALF_UP))

    chase = next(c for c in fx['connections'] if c['id'] == 'chase')
    owner = chase['assign']
    rows = [e for e in chase['events'] if e['type'] == 'txn.upsert']
    snap = {e['accountExternalId']: e['current']['minor'] for e in chase['events'] if e['type'] == 'balance.snapshot'}
    # Kestrel's rows: every CSV line once (the two exports overlap in June and July), with the bank's running balance.
    seen, kestrel = set(), []
    for u in fx['uploads']:
        for line in u['csv'].strip().split('\n')[1:]:
            d, t, a, b = line.split(',')
            if (d, t, a) not in seen:
                seen.add((d, t, a))
                kestrel.append({'date': d, 'text': t, 'minor': int(Decimal(a) * 100), 'balance': int(Decimal(b) * 100)})
    kestrel.sort(key=lambda r: r['date'])
    k_balance = kestrel[-1]['balance']
    rule_revenue = {'Globex Corp', 'Initech', 'Siemens AG'}
    rejected = set()
    for a in fx['actions']:
        if a['do'] == 'reject_matches':
            rejected |= set(a['externalIds'])

    def kind_of(t):
        refs = t.get('linkRefs') or {}
        if 'transfer' in refs and owner[t['accountExternalId']] != 'Personal':
            return 'between companies'
        if 'card_payment' in refs:
            return 'card payment'
        if t['counterparty'] in rule_revenue:
            return 'revenue'
        if t.get('categoryHint') == 'INCOME_WAGES':
            return 'wages'
        if t['externalId'] == 'bl_paid_by_ns':
            return 'invoice payment'   # Brightline's INV-B-100, paid by Northstar: revenue to Brightline
        if t['amount']['minor'] < 0:
            return 'spending'
        raise SystemExit(f'unexplained: {t["externalId"]}')

    # Per company: (date, minor in USD) for spending and revenue.
    spend = defaultdict(list)
    revenue = defaultdict(list)
    wages = []
    for t in rows:
        who, k, a = owner[t['accountExternalId']], kind_of(t), t['amount']['minor']
        if k == 'spending':
            spend[who].append((t['date'], -a))
        elif k in ('revenue', 'invoice payment'):
            revenue[who].append((t['date'], a))
        elif k == 'wages':
            wages.append((t['date'], a))
    by_day = defaultdict(int)
    for r in kestrel:
        if r['text'] in rule_revenue:
            revenue['Kestrel GmbH'].append((r['date'], to_usd(r['minor'], r['date'])))
        else:
            by_day[r['date']] += -r['minor']
    for d, m in by_day.items():
        spend['Kestrel GmbH'].append((d, to_usd(m, d)))
    tot = lambda rows_, f, t: sum(m for d, m in rows_ if f <= d <= t)

    q = Q(fx['scenario'], fx['now'])
    cos = ['Northstar Labs', 'Brightline Studio', 'Kestrel GmbH']
    metric = lambda co, name, **extra: {'tool': 'get_metric', 'args': {'metric': name, 'company': co, **extra}, 'path': 'value'}
    slug = {'Northstar Labs': 'ns', 'Brightline Studio': 'bl', 'Kestrel GmbH': 'ke', 'all': 'all'}
    cash = {'Northstar Labs': snap['ns_chk'], 'Brightline Studio': snap['bl_chk'], 'Kestrel GmbH': to_usd(k_balance, today.isoformat())}
    notes = {
        'Northstar Labs': 'Northstar Checking. Its Amex is paid by Brightline (owed between the companies), not from this account.',
        'Brightline Studio': 'Brightline Checking, including the $20,000 Northstar sent on Jul 15.',
        'Kestrel GmbH': f'The German account\'s last statement balance (EUR {money(k_balance)}), converted at the as-of day\'s rate ({rate_on(today.isoformat())}).',
    }
    for co in cos:
        q.add(f'{slug[co]}-cash', 'cash', f'How much cash does {co} have (USD)?', 'money', cash[co], metric(co, 'cash'), notes[co], app=(co != 'Brightline Studio'))
    q.add('all-cash', 'cash', 'Cash across all three companies (USD)?', 'money', sum(cash.values()), metric('all', 'cash'), 'The three companies added up (Personal is not a company).', app=True)
    q.add('ke-balance-eur', 'cash', 'What does the Kestrel bank account hold, in euros?', 'money', k_balance,
          {'tool': 'list_accounts', 'args': {'company': 'Kestrel GmbH'}, 'path': 'accounts[0].balance'}, 'Each CSV row once: the two exports overlap in June and July and must not double.', app=True)
    q.add('ns-card', 'cards', 'What is owed on the Northstar Amex?', 'money', -snap['ns_amex'], metric('Northstar Labs', 'card_balances'), 'Paid in full every month (by Brightline).')
    q.add('per-cash', 'cash', 'How much cash is in the Personal space (Dana\'s own account)?', 'money', snap['per_chk'], metric('Personal', 'cash'), 'Dana Checking.')

    m3 = trailing_months(today, 3)
    f3, t3 = month_range(m3[0])[0], month_range(m3[-1])[1]
    r0 = lambda d: int(d.quantize(Decimal('1'), rounding=ROUND_HALF_UP)) if d >= 0 else -int((-d).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
    for co in cos + ['all']:
        sp = [x for c in cos for x in spend[c]] if co == 'all' else spend[co]
        rv = [x for c in cos for x in revenue[c]] if co == 'all' else revenue[co]
        g, r = tot(sp, f3, t3), tot(rv, f3, t3)
        gross_note = {'Northstar Labs': 'Rent, AWS, Dana\'s salary, Amex purchases at swipe, and in August the $6,000 paid to Brightline (an invoice between own companies counts as spending here).',
                      'Brightline Studio': 'Lease and Upwork. Paying Northstar\'s Amex is money owed between the companies, not Brightline\'s spending.',
                      'Kestrel GmbH': 'Rent, Hetzner and bank fees in EUR, each day converted at that day\'s rate.',
                      'all': 'The companies added up: the $6,000 invoice between Northstar and Brightline is in both gross burn and revenue (Known limits).'}[co]
        q.add(f'{slug[co]}-gross-burn', 'burn', f'Average monthly gross burn, {co}?', 'money', r0(Decimal(g) / 3), metric(co, 'gross_burn'), gross_note, app=(co in ('Northstar Labs', 'all')))
        q.add(f'{slug[co]}-net-burn', 'burn', f'Average monthly net burn, {co}?', 'money', r0(Decimal(g - r) / 3), metric(co, 'net_burn'), 'Gross burn minus revenue, monthly average of Jul-Sep.')
        q.add(f'{slug[co]}-revenue-q3', 'revenue', f'Cash revenue in Q3, {co}?', 'money', r, metric(co, 'revenue', **{'from': f3, 'to': t3}),
              {'Northstar Labs': 'Globex, monthly.', 'Brightline Studio': 'Initech monthly, plus INV-B-100 paid by Northstar in August.', 'Kestrel GmbH': 'Siemens monthly in EUR, each converted at its day\'s rate.', 'all': 'Includes the $6,000 Brightline invoiced Northstar (counted in both companies).'}[co], app=(co == 'all'))
        for ym in m3:
            f, t = month_range(ym)
            q.add(f'{slug[co]}-gross-{ym}', 'burn', f'Gross burn in {ym}, {co}?', 'money', tot(sp, f, t), metric(co, 'gross_burn', **{'from': f, 'to': t}), 'That month\'s total.')
    paid = sum(-t['amount']['minor'] for t in rows if t['externalId'].startswith('bl_amexpay_'))
    sent = sum(-t['amount']['minor'] for t in rows if t['externalId'] == 'ns_ic_out')
    q.add('ns-intercompany', 'intercompany', 'What do Northstar and Brightline owe each other, from Northstar\'s side?', 'money', sent - paid, metric('Northstar Labs', 'intercompany_balance'),
          'Due from − due to: Brightline owes Northstar the $20,000 sent on Jul 15; Northstar owes Brightline every Amex bill Brightline paid for it.', app=True)
    q.add('bl-intercompany', 'intercompany', 'What is Brightline Studio\'s intercompany balance with Northstar Labs?', 'money', paid - sent, metric('Brightline Studio', 'intercompany_balance'), 'The mirror image.')
    q.add('all-intercompany', 'intercompany', 'Intercompany balance across the group?', 'money', 0, metric('all', 'intercompany_balance'), 'Nets to zero across the companies.')
    q.add('ke-intercompany', 'intercompany', 'Does Kestrel owe or lend to the others?', 'money', 0, metric('Kestrel GmbH', 'intercompany_balance'), 'No money moved between Kestrel and the others.')
    w = tot(wages, f3, t3)
    q.add('per-wages-q3', 'income', 'Salary received in the Personal space in Q3?', 'money', w,
          {'tool': 'get_reports', 'args': {'kind': 'profit_and_loss', 'company': 'Personal', 'from': f3, 'to': t3, 'basis': 'cash'}, 'path': 'reports[0].sections[*].rows[account~wages].amount', 'abs': True},
          'Pay from Northstar: income, not money owed between Northstar and Dana (she rejected that suggestion).', app=True)
    q.add('per-spend-q3', 'spending', 'Spending in the Personal space in Q3 (monthly average)?', 'money', r0(Decimal(tot(spend['Personal'], f3, t3)) / 3), metric('Personal', 'gross_burn'), 'Rent and groceries.')
    q.add('ns-salary-sep', 'payroll', 'What did Northstar pay Dana Park (her salary) in September?', 'money', 750_000,
          {'tool': 'query_transactions', 'args': {'company': 'Northstar Labs', 'from': '2026-09-01', 'to': '2026-09-30', 'query': 'Dana Park', 'measures': ['sum']}, 'path': 'totals[0].sum', 'abs': True}, 'One salary payment a month.')

    # ---- more: each company's September, quarter results, the overlapping exports, Personal ----
    qt = lambda co, query, f, t, measure='sum', abs_=True: {'tool': 'query_transactions', 'args': {'company': co, 'from': f, 'to': t, 'query': query, 'measures': [measure]}, 'path': f'totals[0].{measure}', **({'abs': True} if abs_ else {})}
    for co in cos:
        q.add(f'{slug[co]}-revenue-2026-09', 'revenue', f'Cash revenue in September, {co}?', 'money', tot(revenue[co], '2026-09-01', '2026-09-30'), metric(co, 'revenue', **{'from': '2026-09-01', 'to': '2026-09-30'}), 'One customer payment.')
        q.add(f'{slug[co]}-pnl-q3', 'reports', f'Net income for Q3, {co} (cash basis)?', 'money', tot(revenue[co], f3, t3) - tot(spend[co], f3, t3),
              {'tool': 'get_reports', 'args': {'kind': 'profit_and_loss', 'company': co, 'from': f3, 'to': t3, 'basis': 'cash'}, 'path': 'reports[0].total'},
              'Revenue minus spending, Jul-Sep (in USD; Kestrel day by day at each day\'s rate).')
    q.add('ke-rows', 'statements', 'How many transactions does Kestrel have Apr-Sep?', 'count', len(kestrel), qt('Kestrel GmbH', '', '2026-04-01', '2026-09-30', 'count'),
          'Each CSV row once: 4 a month for 6 months; the June and July rows are in both exports.', app=True)
    hetz = sum(-r['minor'] for r in kestrel if r['text'].startswith('Hetzner') and f3 <= r['date'] <= t3)
    q.add('ke-hetzner-q3-eur', 'statements', 'What did Kestrel pay Hetzner in Q3, in euros?', 'money', hetz, qt('Kestrel GmbH', 'Hetzner', f3, t3), 'In the account\'s currency (EUR), three monthly payments.')
    q.add('ke-fees-sep-eur', 'fees', 'Kestrel\'s bank fees in September, in euros?', 'money', 950, qt('Kestrel GmbH', 'Kontofuehrung', '2026-09-01', '2026-09-30'), 'Kontofuehrung (account fee), EUR 9.50 a month.')
    amex_q3 = sum(-t['amount']['minor'] for t in rows if t['accountExternalId'] == 'ns_amex' and t['amount']['minor'] < 0 and f3 <= t['date'] <= t3)
    q.add('ns-amex-spend-q3', 'cards', 'What was charged to the Northstar Amex in Q3?', 'money', amex_q3, qt('Northstar Labs', 'out account:Amex', f3, t3), 'Figma, Adobe and Delta each month (the payments in are card payments).', app=True)
    q.add('bl-upwork-q3', 'spending', 'What did Brightline pay Upwork in Q3?', 'money', 3 * 300_000, qt('Brightline Studio', 'counterparty:Upwork', f3, t3), '$3,000 a month.')
    rent = sum(-t['amount']['minor'] for t in rows if t['counterparty'] == 'Elm Street Apartments' and f3 <= t['date'] <= t3)
    q.add('per-rent-q3', 'spending', 'Rent paid from the Personal space in Q3?', 'money', rent, qt('Personal', 'counterparty:"Elm Street Apartments"', f3, t3), '$2,600 a month.')
    groc = sum(-t['amount']['minor'] for t in rows if t['counterparty'] == 'Trader Joes' and t['date'].startswith('2026-09'))
    q.add('per-groceries-sep', 'spending', 'Groceries in the Personal space in September?', 'money', groc, qt('Personal', 'counterparty:"Trader Joes"', '2026-09-01', '2026-09-30'), 'One Trader Joe\'s trip.')
    q.add('per-net-q3', 'income', 'How much did the Personal space save in Q3 (income minus spending, cash basis)?', 'money', w - tot(spend['Personal'], f3, t3),
          {'tool': 'get_reports', 'args': {'kind': 'profit_and_loss', 'company': 'Personal', 'from': f3, 'to': t3, 'basis': 'cash'}, 'path': 'reports[0].total'}, 'Salary minus rent and groceries.')
    return q


def s4(fx):
    co = fx['company']
    today = date.fromisoformat(fx['now'][:10])
    bank = fx['connections'][0]['events']
    rows = [e for e in bank if e['type'] == 'txn.upsert']
    cash = next(e['current']['minor'] for e in bank if e['type'] == 'balance.snapshot')
    # The fund's rules (description text -> category): partners' capital and other assets are neither spending nor
    # sales; everything else that goes out is the fund's expenses.
    rules = [(a['args']['match']['description_contains'].lower(), a['args']['set']['category']) for a in fx['actions'] if a['do'] == 'create_rule']

    def what(t):
        text = f'{t["counterparty"]} {t["rawText"]}'.lower()
        cat = next((c for w, c in rules if w in text), None)
        if cat:
            return cat
        if t['amount']['minor'] < 0:
            return 'expense'
        raise SystemExit(f'unexplained money in: {t["externalId"]}')

    for t in rows:
        t['_what'] = what(t)
    expenses = [(t['date'], -t['amount']['minor'], t) for t in rows if t['_what'] == 'expense']
    tot = lambda f, to, keep=lambda t: True: sum(m for d, m, t in expenses if f <= d <= to and keep(t))
    flow = lambda f, to, keep: sum(t['amount']['minor'] for t in rows if f <= t['date'] <= to and keep(t))
    r0 = lambda d: int(d.quantize(Decimal('1'), rounding=ROUND_HALF_UP))

    q = Q(fx['scenario'], fx['now'])
    metric = lambda name, **extra: {'tool': 'get_metric', 'args': {'metric': name, 'company': co, **extra}, 'path': 'value'}
    qsum = lambda query, f='2026-04-01', to='2026-09-30', measure='sum': {'tool': 'query_transactions', 'args': {'company': co, 'from': f, 'to': to, 'query': query, 'measures': [measure]}, 'path': f'totals[0].{measure}', **({'abs': True} if measure == 'sum' else {})}
    pnl = lambda f, to, path, abs_=False: {'tool': 'get_reports', 'args': {'kind': 'profit_and_loss', 'company': co, 'from': f, 'to': to, 'basis': 'cash'}, 'path': path, **({'abs': True} if abs_ else {})}
    bs = lambda path: {'tool': 'get_reports', 'args': {'kind': 'balance_sheet', 'company': co, 'from': '2026-09-01', 'to': '2026-09-30', 'basis': 'cash'}, 'path': path}

    # ---- cash ----
    q.add('cash', 'cash', f'How much cash does {co} have?', 'money', cash, metric('cash'), 'Fund Checking\'s current balance on Oct 11 (the only account).', app=True)
    q.add('cash-checking', 'cash', 'What is the Fund Checking balance?', 'money', cash, {'tool': 'list_accounts', 'args': {'company': co}, 'path': 'accounts[name=Fund Checking].balance'}, 'Same account.')
    q.add('overview-cash', 'cash', 'What cash does the overview show?', 'money', cash, {'tool': 'get_overview', 'args': {'company': co}, 'path': 'companies[0].cash'}, 'Same as get_metric cash.')

    # ---- burn and runway: only the fund's expenses ----
    m3 = trailing_months(today, 3)
    f3, t3 = month_range(m3[0])[0], month_range(m3[-1])[1]
    g3 = tot(f3, t3)
    avg = Decimal(g3) / 3
    burn_note = ('The fund\'s own expenses: the quarterly management fee, Carta, Cooley and wire fees. Capital calls, distributions to LPs, '
                 'investments and the Pinecrest exit are partners\' capital and the fund\'s assets, not spending or sales.')
    q.add('gross-burn', 'burn', f'What is {co}\'s average monthly gross burn?', 'money', r0(avg), metric('gross_burn'), f'Monthly average of {f3}..{t3}. {burn_note}', app=True)
    q.add('net-burn', 'burn', f'What is {co}\'s average monthly net burn?', 'money', r0(avg), metric('net_burn'), 'No revenue: the $1.2M exit is the return of an investment, not sales, so net burn = gross burn.', app=True)
    runway = (Decimal(cash) / avg).quantize(Decimal('0.1'), rounding=ROUND_HALF_UP)
    q.add('runway', 'runway', f'How many months of runway does {co} have?', 'number', float(runway), metric('runway'), 'Cash ÷ average monthly net burn of Jul-Sep, to one decimal.', app=True)
    q.add('overview-burn', 'burn', 'What net burn does the overview show?', 'money', r0(avg), {'tool': 'get_overview', 'args': {'company': co}, 'path': 'companies[0].net_burn_3mo'}, 'Same as get_metric net_burn.')
    q.add('overview-runway', 'runway', 'What runway does the overview show?', 'number', float(runway), {'tool': 'get_overview', 'args': {'company': co}, 'path': 'companies[0].runway_months'}, 'Same as get_metric runway.')
    month_note = {'2026-04': 'Q2 management fee, Carta, wire fees (fee and Tidewell).', '2026-05': 'Carta, Cooley, the Corvid wire fee.', '2026-06': 'Carta and the Pinecrest wire fee; the $400,000 investment is not spending.',
                  '2026-07': 'Q3 management fee, Carta, two wire fees; the $1M Brightwave investment is not spending.', '2026-08': 'Carta and Cooley; the $1.2M Pinecrest exit is not revenue.', '2026-09': 'Carta and four wire fees (Quillmark and three LP distributions).'}
    for ym in MONTHS_S4:
        f, t = month_range(ym)
        q.add(f'gross-burn-{ym}', 'burn', f'What were the fund\'s expenses in {ym}?', 'money', tot(f, t), metric('gross_burn', **{'from': f, 'to': t}), month_note[ym], app=(ym == '2026-07'))
    q.add('revenue-q3', 'revenue', 'What was the fund\'s revenue in Q3?', 'money', 0, metric('revenue', **{'from': f3, 'to': t3}), 'None: the Pinecrest acquisition proceeds return an investment (other assets), they are not sales.', app=True)
    q.add('revenue-aug', 'revenue', 'Revenue in August?', 'money', 0, metric('revenue', **{'from': '2026-08-01', 'to': '2026-08-31'}), 'The $1.2M exit is not revenue.')
    q.add('net-burn-q2', 'burn', 'Average monthly net burn over Q2 (Apr-Jun)?', 'money', r0(Decimal(tot('2026-04-01', '2026-06-30')) / 3), metric('net_burn', **{'from': '2026-04-01', 'to': '2026-06-30'}), 'Q2 total ÷ 3.')
    q.add('pnl-q3-net', 'reports', 'Net income for Q3 on the cash basis?', 'money', -g3, pnl(f3, t3, 'reports[0].total'), 'Expenses only, no income: −(Q3 expenses).')
    q.add('pnl-ytd-net', 'reports', 'Net income Apr-Sep (cash basis)?', 'money', -tot('2026-04-01', '2026-09-30'), pnl('2026-04-01', '2026-09-30', 'reports[0].total'), 'Six months of expenses, no income.')

    # ---- expenses by kind ----
    mgmt = lambda t: t['counterparty'].startswith('Harbor Seed Management')
    fee = lambda t: t['rawText'] == 'OUTGOING WIRE FEE'
    q.add('mgmt-fee-ytd', 'expenses', 'How much management fee has the fund paid Apr-Sep?', 'money', tot('2026-04-01', '2026-09-30', mgmt), qsum('counterparty:"Harbor Seed Management LLC"'), 'Two quarterly payments of $125,000 (2% a year of $25M).', app=True)
    q.add('wire-fees-q3', 'fees', 'What did wire fees cost in Q3?', 'money', tot(f3, t3, fee), qsum('"wire fee"', f3, t3), '$30 on each outgoing wire: the Q3 fee, Brightwave, Quillmark and the three LP distributions.', app=True)
    q.add('wire-fees-sep-count', 'fees', 'How many wire fees were charged in September?', 'count', sum(1 for d, m, t in expenses if fee(t) and d.startswith('2026-09')), qsum('"wire fee"', '2026-09-01', '2026-09-30', 'count'), 'Quillmark + three LP distributions.')
    q.add('carta-ytd', 'expenses', 'What has Carta cost Apr-Sep?', 'money', tot('2026-04-01', '2026-09-30', lambda t: t['counterparty'] == 'Carta'), qsum('counterparty:Carta'), '$1,250 a month.')
    q.add('legal-ytd', 'expenses', 'What has the fund paid Cooley Apr-Sep?', 'money', tot('2026-04-01', '2026-09-30', lambda t: t['counterparty'] == 'Cooley LLP'), qsum('counterparty:"Cooley LLP"'), 'May and August.', app=True)

    # ---- partners' capital ----
    called = lambda t: t['_what'] == 'paid_in_capital' and t['amount']['minor'] > 0
    dist = lambda t: t['_what'] == 'paid_in_capital' and t['amount']['minor'] < 0
    total_called = flow('2026-04-01', '2026-09-30', called)
    total_dist = -flow('2026-04-01', '2026-09-30', dist)
    q.add('called-ytd', 'capital', 'How much capital did the LPs pay in Apr-Sep?', 'money', total_called, qsum('in "capital call"'), 'Two calls of $2M (Apr 15, Jul 15), each wired by the three LPs pro rata.', app=True)
    q.add('called-q3', 'capital', 'How much capital was called in Q3?', 'money', flow(f3, t3, called), qsum('in "capital call"', f3, t3), 'The Jul 15 call.')
    q.add('distributed', 'capital', 'How much has the fund distributed to its LPs?', 'money', total_dist, qsum('out "lp distribution"'), 'Sep 15: $1M pro rata.', app=True)
    for lp, slug in (('Granite Pension Fund', 'granite'), ('Alder Family Office', 'alder'), ('Juniper Endowment', 'juniper')):
        paid_in = flow('2026-04-01', '2026-09-30', lambda t: called(t) and t['counterparty'] == lp)
        got = -flow('2026-04-01', '2026-09-30', lambda t: dist(t) and t['counterparty'] == lp)
        q.add(f'{slug}-paid-in', 'capital', f'How much has {lp} paid in?', 'money', paid_in, qsum(f'in counterparty:"{lp}"'), 'Its share of both calls.', app=(slug == 'granite'))
        q.add(f'{slug}-received', 'capital', f'How much has {lp} received back?', 'money', got, qsum(f'out counterparty:"{lp}"'), 'Its share of the Sep 15 distribution (the wire fee is the fund\'s, under Mercury).')
    q.add('bs-paid-in-capital', 'reports', 'Paid-in capital on the balance sheet at Sep 30?', 'money', total_called - total_dist, bs('reports[0].sections[*].rows[account~Paid-in].amount'),
          'Calls minus the distribution to LPs, Apr-Sep (the balance before April is opening balances).')

    # ---- investments (cost, as other assets) ----
    invest = lambda t: t['_what'] == 'other_assets' and t['amount']['minor'] < 0
    invested = -flow('2026-04-01', '2026-09-30', invest)
    proceeds = flow('2026-04-01', '2026-09-30', lambda t: t['_what'] == 'other_assets' and t['amount']['minor'] > 0)
    q.add('invested-ytd', 'investments', 'How much has the fund invested Apr-Sep?', 'money', invested, qsum('out investment'), 'Five wires: Tidewell, Corvid, Pinecrest, Brightwave, Quillmark (wire fees are expenses, not cost).', app=True)
    q.add('invested-count', 'investments', 'How many investments did the fund make Apr-Sep?', 'count', sum(1 for t in rows if invest(t)), qsum('out investment', measure='count'), 'One wire each.')
    q.add('invested-q3', 'investments', 'How much was invested in Q3?', 'money', -flow(f3, t3, invest), qsum('out investment', f3, t3), 'Brightwave (Jul 22) and Quillmark (Sep 9).')
    for t in (t for t in rows if invest(t)):
        slug = t['counterparty'].split()[0].lower()
        q.add(f'invested-{slug}', 'investments', f'How much did the fund put into {t["counterparty"]}?', 'money', -t['amount']['minor'], qsum(f'out counterparty:"{t["counterparty"]}"'), f'One wire on {t["date"]}.', app=(slug == 'brightwave'))
    q.add('exit-proceeds', 'investments', 'What did the fund receive when Pinecrest AI was acquired?', 'money', proceeds, qsum('in "acquisition proceeds"'), 'From the buyer, Northwind Software, on Aug 27 ($400,000 cost back, $800,000 gain).', app=True)
    q.add('bs-other-assets', 'reports', 'Other assets on the balance sheet at Sep 30?', 'money', invested - proceeds, bs('reports[0].sections[*].rows[account~Other assets].amount'),
          'Investments at cost less the exit proceeds, since all of it is categorized as other assets. Changes when portfolio tracking posts the exit as cost back + gain.')
    return q


def s5(fx):
    conns = {c['id']: c['events'] for c in fx['connections']}
    nw, east = fx['company'], fx['companies'][0]['name']
    bank = [e for e in conns['plaid'] if e['type'] == 'txn.upsert']
    stripe = [e for e in conns['stripe'] if e['type'] == 'processor.balance_txn']
    qbo = conns['qbo']
    moved = [a for a in fx['actions'] if a['do'] == 'add_entry' and a['args']['kind'] == 'intercompany']
    moved_minor = sum(int(Decimal(a['args']['amount']['amount']) * 100) for a in moved)
    wire = -sum(t['amount']['minor'] for t in bank if t['counterparty'] == east)

    def month(rows, ym):
        return sum(m for d, m in rows if d.startswith(ym))

    # Spending, by the definitions: bank costs (not payouts, not money to Eastside), Stripe fees, customer refunds at what
    # was paid back. Revenue: Stripe charges at gross; invoice 1038's payment is the same money as its charge.
    costs = [(t['date'], -t['amount']['minor']) for t in bank if t['amount']['minor'] < 0 and t['counterparty'] != east]
    costs += [(day_of(e), e['fee']['minor']) for e in stripe]
    refunds = [(day_of(e), -e['gross']['minor']) for e in stripe if e['kind'] == 'refund']
    charges = [(day_of(e), e['gross']['minor']) for e in stripe if e['kind'] == 'charge']
    # Accrual: the invoice by issue date stands in for its charge; a refund takes off what it paid back, less the tax.
    invoiced = {e['externalId']: e for e in qbo if e['type'] == 'invoice.upsert'}
    note = next(e for e in qbo if e['type'] == 'credit_note.upsert')
    paid_charges = [(day_of(e), e['gross']['minor']) for e in stripe if e['kind'] == 'charge' and e['counterparty'] != 'Globex Corp']
    accrual = [(e['issueDate'], e['total']['minor']) for e in invoiced.values()] + paid_charges + [(note['date'], -(note['amount']['minor'] - note['tax']['minor']))]

    q = Q(fx['scenario'], fx['now'])
    # History starts mid-July, so of the last three months only August and September are whole.
    full = ['2026-08', '2026-09']
    spent = sum(month(costs, m) + month(refunds, m) for m in full)
    got = sum(month(charges, m) for m in full)
    metric = lambda name, company, **a: {'tool': 'get_metric', 'args': {'metric': name, 'company': company, **a}, 'path': 'value'}
    cash = fx['openingBalances']['chk'] + sum(t['amount']['minor'] for t in bank) - moved_minor
    q.add('cash', 'balances', f"What is {nw}'s cash?", 'money', cash, metric('cash', nw), 'The bank balance, counted once with two sources, an empty Stripe balance, less the one-sided entry paid from Cash on hand.', app=True)
    half = lambda m: int((Decimal(m) / 2).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    q.add('gross-burn', 'burn', f"What is {nw}'s monthly gross burn?", 'money', half(spent), metric('gross_burn', nw), 'August and September only: July is partial, so it is in neither the spending nor the divisor.', app=True)
    q.add('net-burn', 'burn', f"What is {nw}'s monthly net burn?", 'money', half(spent - got), metric('net_burn', nw), 'The same two months, less Stripe charges.')
    for m in ('2026-08', '2026-09'):
        frm, to = month_range(m)
        q.add(f'gross-burn-{m}', 'burn', f'Gross burn for {m}?', 'money', month(costs, m) + month(refunds, m), metric('gross_burn', nw, **{'from': frm, 'to': to}), 'Copies from the second source and money to Eastside are out.')
        q.add(f'revenue-{m}', 'revenue', f'Cash revenue for {m}?', 'money', month(charges, m) - month(refunds, m), metric('revenue', nw, **{'from': frm, 'to': to}), 'Each payment once; refunds at what was paid back.')
        q.add(f'revenue-accrual-{m}', 'revenue', f'Accrual revenue for {m}?', 'money', month(accrual, m), metric('revenue', nw, **{'from': frm, 'to': to, 'basis': 'accrual'}), 'Invoice 1038 once; the taxed refund once, net of tax.', app=(m == '2026-09'))
    q.add('intercompany-northwind', 'intercompany', f'What does {east} owe {nw}?', 'money', wire + moved_minor, metric('intercompany_balance', nw), 'The wire seen on both sides plus the one-sided entry.')
    q.add('intercompany-eastside', 'intercompany', f'What is {east} owed?', 'money', -wire, metric('intercompany_balance', east), 'Only the wire: the entry has no side in Eastside until its money arrives.')
    east_spent = -sum(t['amount']['minor'] for t in conns['east'] if t['type'] == 'txn.upsert' and t['amount']['minor'] < 0 and t['date'].startswith('2026-09'))
    q.add('eastside-burn', 'burn', f'Gross burn at {east} for September?', 'money', east_spent, metric('gross_burn', east, **{'from': '2026-09-01', 'to': '2026-09-30'}), 'Its one bill: money moved between companies is not spending. (A month with no rows is unknown, not zero, so the month has a real cost.)')
    aug = sum(1 for t in bank if t['date'].startswith('2026-08'))
    q.add('august-rows', 'second source', 'How many bank transactions in August?', 'count', aug, {'tool': 'query_transactions', 'args': {'company': nw, 'from': '2026-08-01', 'to': '2026-08-31', 'query': '', 'measures': ['count']}, 'path': 'totals[0].count', 'abs': True}, 'Each row once, though two sources show it.')
    return q


MONTHS_S4 = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']
SCENARIOS = {'s1-individual': s1, 's2-founder': s2, 's3-operator': s3, 's4-vc': s4, 's5-same-money': s5}


RATES_OVERRIDE = None


def main(argv):
    # --rates FILE (a JSON list of {date, from, to, rate}) keys S3 at those rates instead of the fixture's and writes
    # key.<label>.json (--label, default "rates"): staging converts at its own rates, so its answers differ by FX alone.
    global RATES_OVERRIDE
    args = argv[1:]
    label = None
    if '--rates' in args:
        i = args.index('--rates')
        RATES_OVERRIDE = json.load(open(args[i + 1]))
        del args[i:i + 2]
        label = 'rates'
    if '--label' in args:
        i = args.index('--label')
        label = args[i + 1]
        del args[i:i + 2]
    names = args or list(SCENARIOS)
    for name in names:
        path = os.path.join(ROOT, name, 'fixture.json')
        raw = open(path, 'rb').read()
        q = SCENARIOS[name](json.loads(raw))
        out = {'scenario': name, 'fixture_sha256': hashlib.sha256(raw).hexdigest(), 'as_of': q.as_of, 'questions': q.rows}
        if RATES_OVERRIDE is not None:
            out['rates'] = 'override'
        with open(os.path.join(ROOT, name, f'key.{label}.json' if label else 'key.json'), 'w') as f:
            json.dump(out, f, indent=1, ensure_ascii=False)
            f.write('\n')
        print(f'{name}: {len(q.rows)} questions ({sum(1 for r in q.rows if r.get("app"))} for the apps)')


if __name__ == '__main__':
    main(sys.argv)
