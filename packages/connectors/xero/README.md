# @agfn/connector-xero

Read-only Xero connector (OAuth 2.0, granular scopes). One sign-in can cover several organisations: each ticked
organisation becomes its own connection sharing the token. Syncs the chart of accounts, invoices and bills, credit
notes, payments, overpayments, prepayments, bank transactions (spend and receive money), manual journals and the
monthly P&L (with Xero's own totals for cross-checking ours).

How lines land in our books:
- Each line takes its account's Xero class and type: Direct Costs are cost of goods sold, Other Income stays other
  income; lines on asset or liability accounts go to inventory, fixed assets, prepaid, other assets or other
  liabilities. Tax-inclusive lines are booked net of tax.
- Spend and receive money are paid documents with their payment ("banktxn:<id>").
- Manual journals with P&L lines post as journals ("mj:<id>"); the bank side is left to the bank feed.
- Credit notes carry their tax, so sales tax payable drops with them.

Known gap: Xero gives apps no access to Xero Payroll or expense claims (accounting.journals.read isn't offered to new
apps, and US payroll runs through Gusto). Wages, payroll tax and claimed expenses in Xero's P&L are missing from ours.
The provider_report check flags those months and says why. Connect Gusto (via Finch) or the bank to include wages.
Revisit only if we move to Xero's Advanced tier: journals is an Advanced-only premium feature behind a security
assessment and use-case approval.

Tests: `npx vitest run --maxWorkers=1 packages/connectors/xero apps/server/src/scenarios/14-xero-pnl.test.ts`
(scenario 14 replays the Demo Company (US): July equals Xero's P&L to the cent; August and September match on revenue
and cost of sales).
