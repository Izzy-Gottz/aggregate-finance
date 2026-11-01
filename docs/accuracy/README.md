# Accuracy scenarios

Four synthetic workspaces whose every figure is known in advance, checked to the cent on every merge.

| Scenario | Who | Status |
| --- | --- | --- |
| `s2-founder` | Lumen Labs: bank, card, Stripe (fees, a refund, payouts), payroll debits, invoices (paid, partly paid, overdue), a bill, a SAFE, a founder loan | 49 questions, all pass (SQLite and Postgres) |
| `s1-individual` | Sam Lee, Personal only: checking, savings, two cards (a refund, a pending charge), brokerage and Coinbase holdings, a car loan with terms | 50 questions, all pass |
| `s3-operator` | Dana Park: three companies (one keeping EUR books from two overlapping CSV exports) + Personal, a transfer and an invoice between companies, a card paid from another company's bank, her salary | 52 questions, all pass |
| `s4-vc` | Harbor Seed Fund I kept as a company: three LPs' capital calls and a distribution back, the quarterly management fee, five investments wired out, an exit's proceeds, wire fees; told apart with rules (partners' capital, other assets) | 44 questions, all pass. Positions, gains and write-offs come with portfolio tracking |

## How it works

- **Fixture** (`apps/server/src/accuracy/<scenario>/fixture.json`): what the providers send (connector events, with
  `connectionId` as `$conn`) and what the person does in the app afterwards (`actions`: confirm Review's matches,
  answer "What is this money?", record equity). Written by `scripts/accuracy/gen_<scenario>.py`.
- **Key** (`key.json`): computed by `scripts/accuracy/key.py` from the fixture alone. It never imports or calls
  Aggregate code. Each question is in the benchmark's `questions.json` shape (id, category, question, answer,
  tolerance, as_of, notes; `app: true` marks the ones also asked through Claude and ChatGPT) plus `check`: the MCP
  tool, its arguments and the field compared. The key records the fixture's sha256, so a fixture edited without a new
  key fails.
- **Suite** (`apps/server/src/accuracy/<scenario>.test.ts`): boots the real server, connects and syncs each provider
  through the scenario harness, does the actions through MCP, then asks every question. Money must match to the cent.
  The clock is pinned to the fixture's `now` (Date only).

```sh
python3 scripts/accuracy/gen_s2.py          # rewrite the fixture (only when changing the scenario)
python3 scripts/accuracy/key.py s2-founder  # recompute the key
npx vitest run apps/server/src/accuracy/s2-founder.test.ts --maxWorkers=1
```

The same fixtures load through provider sandboxes (63's sweep: Plaid `user_custom` for banks and cards, statement
uploads, QuickBooks sandbox) and are asked through the apps (43's runner), all against the same `key.json`.

## Definitions the keys use

As in [Definitions](../guides/definitions.md):

- **Cash:** the latest current balance of accounts counted as cash (bank, cash on hand, processor balance). Cards are
  not subtracted.
- **Gross burn:** every expense (card purchases at swipe, payroll, fees, taxes) plus customer refunds. Excluded:
  transfers, card payments, payouts, owner and investor money, loan principal. **Net burn:** gross burn minus revenue
  and other income.
- **Burn is a monthly average.** Without a start date, the last 3 full months that history reaches; for a period,
  its total ÷ the calendar months it spans.
- **Runway:** cash ÷ average monthly net burn of the last 3 full months, to one decimal.
- **Cash revenue:** processor charges at gross minus refunds, plus invoice payments received. **Accrual revenue:**
  invoices by issue date plus processor charges, minus refunds.
- **Owed to you / overdue:** what is left on open and partly paid invoices / of those past their due date.
  **Bills due:** open bills due in the next 30 days.
- **Several companies (company "all"):** the companies added up; Personal only when named. A transfer between them
  is owed between them; an invoice between them counts in both (Known limits).
- **FX:** a company's figures are converted to the workspace currency day by day at that day's rate (each day's total,
  rounded half away from zero), balances at the as-of day's rate. The fixture carries its own rates.
- **MRR:** active subscriptions, monthly-normalized (yearly ÷ 12). **Fully diluted:** issued shares + granted
  options; an unconverted SAFE is listed, not counted in shares.

## When the key and Aggregate disagree

Every mismatch is triaged with evidence: a key bug, a fixture bug, or a product bug. The key is never changed to agree
with Aggregate without a written reason in that question's `notes`. Product bugs get a fix with a test, or go to their
owner.

### Triage log

- 2026-10-12, S2 first run: 34 of 38 matched; the 4 others were the suite reading the wrong field (paths), not wrong
  numbers. The SAFE wire was matched to the recorded SAFE automatically, so the fixture no longer answers it by hand.
- 2026-10-12, S1: 24 of 31 matched at first; the rest were paths. The person's key must name their Personal space
  (never part of "all").
- 2026-10-12, S3, product bugs found and fixed or routed:
  - A counterparty rule never matched CSV statement rows (they have only a description): fixed in core (rules.ts).
  - A suggested match between a company and Personal read "money between your companies"; it's owner money, and
    confirming it is not pay: label fixed in core (review.ts).
  - Two documents created in the same millisecond could leave the second unimported for good (ids weren't monotonic,
    the files connector's cursor is the last id): f8 made newId monotonic; the cross-machine case (cursor by
    unprocessed documents) is with 63. The suite spaces its uploads until f8's fix is on main.
  - Company "all" counts Personal when the key covers it (core and the parameter say every company): with 8a; the six
    answers are marked `known_issue` and the suite fails once they match.
  - A CSV without a balance column isn't counted as cash (deliberate: rows alone would make the balance up from zero);
    the fixture's exports carry the bank's running balance, as real ones do.
- 2026-10-12, 43's scripted run of S2 on Haiku 5.5: 46/48, every server figure right; the two misses were question
  wording (fixed: one question per number).
- 2026-10-12, S4 first run: 44 of 44 matched (a one-cent change to the key fails three questions, as it should).
  Investments and exit proceeds are other assets until portfolio tracking posts cost back + gain.
- 2026-10-12, benchmark Arm B triage: processor rows summed at net (a Shopify query gave $74,487.77 for $77,254.66 of
  orders; fees couldn't be found). Fixed in core: a charge lists at gross with its fee as its own row (`<id>:fee`, kind
  fee), the two adding up to net; S2's two pinned questions now match. A payout's record shows its makeup (charges,
  gross, refunds, fees). Unknown tool arguments and `OR` in queries now answer in words (8a).
- 2026-10-12, 43's Haiku runs: S3 31/38 (six are the known "all" issue, one follow-up wording fixed); S4 43/44 (the
  model took an LP for a company).
- 2026-10-12, 8a's scope "all" fix: company "all" no longer counts Personal; S3's six known-issue answers match and
  their markers are gone (52 of 52).
