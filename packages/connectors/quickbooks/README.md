# @agfn/connector-quickbooks

Read-only QuickBooks Online connector (OAuth 2.0). Syncs the chart of accounts, invoices, bills, payments, bill
payments, credit memos, vendor credits, purchases (expenses, checks, card charges), sales receipts, refund receipts,
deposits, deletions (CDC) and the monthly P&L ("Books", with QuickBooks' own totals for cross-checking ours).

How lines land in our books:
- Each line takes its account's QuickBooks type: Cost of Goods Sold, Other Expense and Other Income keep their
  section; lines on balance-sheet accounts go to inventory, fixed assets, other assets or other liabilities.
- Spending booked to an income account is less income, as QuickBooks reports it.
- Inventory items (from each item's InvStartDate) are bought into Inventory; a sale moves their cost to COGS as a
  journal ("cogs:<invoice id>").

Known limitation: cost of sales uses each item's PurchaseCost × quantity. QuickBooks values inventory FIFO, so the two
differ once an item has been bought at different prices. FIFO comes when a real company's books need it.

Tests: `npx vitest run --maxWorkers=1 packages/connectors/quickbooks apps/server/src/scenarios/13-quickbooks-pnl.test.ts`
(scenario 13 replays the recorded Intuit sandbox company and must equal QuickBooks' own P&L to the cent).
