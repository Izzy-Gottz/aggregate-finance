# Prompt recipes

Ten questions worth asking once Aggregate is connected to your AI. Paste the prompt as written, or change the company,
month or numbers. Each one lists the Aggregate tools your AI will call, so you can see where every number comes from.

Aggregate does the counting: cash, burn, runway, MRR and the reports have fixed definitions, and an unknown month is
reported as unknown, never as zero. Your AI does the reasoning on top. Nothing here moves money. A recipe that writes
anything (only the month close) asks you first.

Not connected yet? See [Connect your AI](connect-your-ai.md).

---

## 1. Runway with a hiring plan

**For:** founders

> How many months of runway do we have today, and how many if we hire two engineers at $15,000 a month each starting
> in March? Use Aggregate's runway and net burn, not your own sums.

**Tools:** `get_metric` (`cash`, `net_burn`, `runway`), `get_payroll`, `list_upcoming`

**You get:** today's runway from Aggregate (months until cash runs out at the last three months' net burn), then your
AI's projection with the extra payroll added from March. Aggregate supplies the baseline; the what-if is your AI's
arithmetic, so it shows its working.

## 2. Why did spending change?

**For:** everyone

> Why was September's spending higher than August's? Show the categories that moved most and the biggest single
> transactions behind them.

**Tools:** `query_transactions` (grouped by month and category), `search_transactions`

**You get:** money out by category for both months, the categories with the biggest change, and the transactions
behind them with dates and counterparties. Transfers between your own accounts are not counted as spending.

## 3. Find zombie subscriptions

**For:** everyone

> List my recurring charges. Which ones went up in price, started charging after a free trial, or look like something
> I've stopped using? What do they cost me per month in total?

**Tools:** `list_recurring`, `get_metric` (`recurring_spend`)

**You get:** each subscription found in your bank and card charges, with how often it bills, its monthly cost, price
increases, trials that turned into paid plans and charges that are late or stopped. Whether you still use one is your
call: Aggregate sees the charges, not your logins.

## 4. Who owes us money

**For:** businesses

> Which invoices are overdue? Group them by customer and by how late they are, and tell me which customers usually
> pay slowly.

**Tools:** `query_invoices` (grouped by counterparty and aging), `search_invoices`, `get_counterparty`

**You get:** unpaid invoices in aging buckets (current, 1–30, 31–60, 61–90, 90+ days), the total per customer, and each
customer's average days to pay. Aggregate never sends a reminder; if you want one, ask your AI to draft it.

## 5. What does my company owe me?

**For:** founders and owners

> What does each of my companies owe me personally, from loans, money I put in and expenses I paid on my own card?
> Show the transactions behind each number.

**Tools:** `get_owner_balance`, `get_record`

**You get:** per company, what it owes you (or you owe it), split into loans, contributions, unreimbursed expenses and
owner money not yet labeled, with the rows behind each figure.

## 6. Close the month

**For:** businesses

> Help me close September. What's missing or still waiting for a decision, what does the profit and loss look like,
> and what changed most from August? Don't close anything until I say so.

**Tools:** `get_metric` (`data_health`), `get_coverage`, `list_review_items`, `get_reports`, `query_transactions`,
then `close_period` only if you say yes

**You get:** the gaps that block the close (months an account didn't cover, items to decide), the profit and loss in a
few lines, and the biggest changes from the month before. If you ask it to close the month, the request waits for an
owner or admin to approve it in Aggregate. Most AI clients also offer this as the built-in **Close a month** prompt.

## 7. Contractor spend

**For:** businesses

> How much did we pay contractors each month this year, and who were the biggest ones?

**Tools:** `query_transactions` (category `contractors`, grouped by month and counterparty), `get_payroll`

**You get:** contractor payments month by month and per person or firm, plus the contractor count from your payroll
provider. Needs a connection that can see payroll data.

## 8. Just my own money

**For:** individuals

> How much is in my personal accounts right now, what do I owe on my cards, and what bills are due in the next two
> weeks?

**Tools:** `get_overview` (company `Personal`), `list_accounts`, `list_upcoming`

**You get:** cash in your personal checking and savings, card balances, investments shown apart from cash, and a
dated list of what's coming due. Balances are as of the last sync. Ask for a live check if you need right now
(`refresh_balance`, Plaid banks only; it tells you the cost before anything is called).

## 9. Explain my dilution

**For:** founders and investors

> Walk me through our cap table: who owns what fully diluted, the option pool, and the SAFEs. If we raise $3M at a
> $15M pre-money valuation and the SAFEs convert, roughly what does each holder own afterwards?

**Tools:** `get_cap_table`, `get_metric` (`fully_diluted`)

**You get:** holders, share classes, SAFEs and notes with their caps and discounts, the option pool, RSUs, warrants and
the last 409A, straight from the cap table. The post-round ownership is your AI's calculation on top of those numbers
(Aggregate doesn't model rounds), so check it before you send it anywhere.

## 10. Write my investor update

**For:** founders

> Draft this month's investor update: MRR and how it moved, revenue, burn, cash and runway, plus the three biggest
> changes. Use only numbers from Aggregate and say when one is unknown.

**Tools:** `get_metric` (`mrr`, `net_new_mrr`, `revenue`, `net_burn`, `cash`, `runway`), `get_mrr_movements`,
`get_reports`, `query_transactions`

**You get:** a short draft with every figure taken from Aggregate's fixed definitions, MRR split into new, expansion,
contraction and churn, and the as-of date. You edit it and send it yourself. Aggregate doesn't send anything.

---

## Tips

- **Name the company** when you have several ("for Acme only"); otherwise your AI looks across every company it can see.
- **Ask where a number came from.** Every metric comes with its definition, the accounts included and any stale
  sources, and every record has an audit trail (`get_record`).
- **Unknown is not zero.** If a month is missing for an account, Aggregate says so, and a good answer will too.

Recipes by the Aggregate team. Add yours with a pull request.
