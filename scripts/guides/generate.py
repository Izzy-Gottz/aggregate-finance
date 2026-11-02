"""Generate docs/guides/connect-*.md from one template (keeps the pages consistent; edit here, not the .md files).
Usage: python3 scripts/guides/generate.py docs/guides"""
import os, sys

OUT = sys.argv[1]
CHECKED = '2026-10-12'
LINK = 'https://app.aggregate.finance/mcp'

ASSISTANT = {
    'Claude': '''1. In Claude (claude.ai or Claude Desktop), open **Customize → Connectors** (in some accounts still **Settings →
   Connectors**), choose **Add**, then **Add custom connector**.
2. Name it `Aggregate`, paste `%s` and click **Continue**. Claude detects the sign-in; click **Add**, then **Connect**.
3. Sign in to Aggregate and choose what Claude can see: which companies, which kinds of data, read only or read and
   add, and when access expires.
4. In a new chat, turn on the Aggregate connector and ask a question.

Using Claude Code instead? Run `claude mcp add --transport http --scope user aggregate %s`, then `/mcp` to sign in.''' % (LINK, LINK),
    'ChatGPT': '''1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), choose **Add** (top right), then **Add custom MCP server**.
2. Name it `Aggregate`. Under **Connection**, keep **Server URL** and paste `%s`. Authentication: OAuth.
3. Check **I understand and want to continue**, select **Create as a plugin**, then **Connect** in the dialog.
4. Sign in to Aggregate and choose what ChatGPT can see: which companies, which kinds of data, read only or read and
   add, and when access expires.

In a ChatGPT Business or Enterprise workspace, an admin may need to allow custom MCP servers first.''' % LINK,
}

FAQ = '''## Questions people ask

**Does Aggregate see my password?** No. You sign in on {signin}. Aggregate stores only the access token it gets back,
encrypted with a key kept outside the database.

**Does my data train AI models?** Aggregate never uses your data to train models and doesn't let anyone else. What
{assistant} reads is covered by {assistant_owner}'s own data policy for your plan.

**Can {assistant} move money or change my {source_short}?** No. Aggregate has no tool that pays, transfers, pays a bill
or sends anything, and it only reads from {source_short}.{scope_note} If you allow it, {assistant} can add records
*inside Aggregate* (for example a cash expense), and those can be undone for 30 days.

**What does it cost?** The hosted version is free while we're in beta. We may introduce paid plans later, and we'll let you know before anything changes. Self-hosting is free (AGPL-3.0).

**Can I run it myself?** Yes. Aggregate is open source; see [self-hosting](../self-hosting.md). You'll need your own
{selfhost_need}.
'''

PAGES = [
    dict(slug='connect-quickbooks-to-claude', source='QuickBooks Online', source_short='QuickBooks', assistant='Claude',
         what='invoices, bills, payments, customers, vendors and accounts',
         status='Coming soon on the hosted version. Self-hosted Aggregate works with QuickBooks today using a free Intuit developer app of your own.',
         connect='Open **Workspace → Connections → + More connections → QuickBooks**, sign in to Intuit, pick the company, and approve.',
         signin="Intuit's own sign-in page", scope_note=" (Intuit's permission covers the books as a whole, because Intuit offers no read-only option; Aggregate's QuickBooks connector only makes read requests, plus one call to revoke access when you disconnect.)",
         selfhost_need='Intuit developer app (production keys) for real books',
         qs=[('Which invoices are overdue, and who owes us the most?', 'query_invoices'),
             ('What was our profit and loss last quarter?', 'get_reports'),
             ('What bills are due in the next 14 days?', 'list_upcoming'),
             ('How fast does Acme Corp usually pay us?', 'get_counterparty'),
             ('How much did we spend on software each month this year?', 'query_transactions')]),
    dict(slug='connect-quickbooks-to-chatgpt', base='connect-quickbooks-to-claude', assistant='ChatGPT'),
    dict(slug='connect-xero-to-claude', source='Xero', source_short='Xero', assistant='Claude',
         what='invoices, bills, payments, bank transactions and reports',
         status='Live on the hosted version, with limited room. Aggregate is not a certified Xero app, so hosted Aggregate connects up to 5 Xero organisations in total, across all customers. Each organisation you choose takes one place. If they are all taken, you can [self-host](../self-hosting.md) with your own Xero app, or upload bank statements instead.',
         checked='2026-11-01',
         brings=['Your chart of accounts', 'Invoices and bills, with their credit notes', 'Payments, overpayments and prepayments', 'Bank transactions (spend and receive money)', 'Manual journals', "Your monthly profit and loss, so Aggregate's totals can be checked against Xero's own"],
         not_brought="Xero doesn't give apps access to Xero Payroll or expense claims, so wages, payroll tax and claimed expenses in Xero's profit and loss are missing from Aggregate's. Aggregate flags those months and says why. Connect your bank to include them.",
         connect='Open **Workspace → Connections → + More connections → Xero**, sign in to Xero, choose the organisation, and allow access.',
         signin="Xero's own sign-in page", scope_note=' (Aggregate asks Xero only for read scopes.)',
         selfhost_need='Xero developer app',
         qs=[('Which customers owe us money, and how overdue are they?', 'query_invoices'),
             ('Give me the balance sheet as of the end of last month.', 'get_reports'),
             ('What do we owe suppliers in the next 30 days?', 'list_upcoming'),
             ('How much did we pay this vendor this year?', 'get_counterparty'),
             ('Which expense categories grew the most since last quarter?', 'query_transactions')]),
    dict(slug='connect-xero-to-chatgpt', base='connect-xero-to-claude', assistant='ChatGPT'),
    dict(slug='connect-square-to-claude', source='Square', source_short='Square', assistant='Claude',
         what='payments, refunds, processing fees and payouts',
         status='Live on the hosted version. Cash and other tenders recorded in Square aren\'t imported, because they never pass through your Square balance.',
         connect='Open **Workspace → Connections → + More connections → Square**, sign in to Square, and allow access.',
         signin="Square's own sign-in page", scope_note=' (Aggregate asks Square only for read permissions: payouts, payments, invoices and the merchant profile.)',
         selfhost_need='Square application, or a Square access token',
         qs=[('How much did we sell through Square last month, after fees and refunds?', 'query_transactions'),
             ('Which Square payouts have not shown up in the bank yet?', 'list_review_items'),
             ('How much did Square fees cost us this year?', 'query_transactions'),
             ('How much cash do we have across Square and the bank right now?', 'get_overview'),
             ('Compare this month\'s sales with the same month last year.', 'query_transactions')]),
    dict(slug='connect-stripe-to-claude', source='Stripe', source_short='Stripe', assistant='Claude',
         what='charges, refunds, fees, payouts, invoices and subscription revenue (MRR)',
         status='Works on the hosted version today, and Aggregate is available on the Stripe App Marketplace. Self-hosted Aggregate works too, with a restricted key with read permissions.',
         connect='Open **Workspace → Connections → + More connections → Stripe**, sign in to Stripe, and approve read access. You can connect more than one Stripe account.',
         signin="Stripe's own sign-in page", scope_note=' (Aggregate asks Stripe only for read permissions.)',
         selfhost_need='Stripe restricted key with read permissions',
         qs=[('What is our MRR, and how much came from new customers vs. churn last month?', 'get_mrr_movements'),
             ('Did every Stripe payout this month land in the bank?', 'list_review_items'),
             ('How much did we pay in Stripe fees this quarter?', 'query_transactions'),
             ('Who are our ten largest customers by revenue this year?', 'query_transactions'),
             ('Which invoices are past due?', 'query_invoices')]),
    dict(slug='connect-shopify-to-chatgpt', source='Shopify', source_short='Shopify', assistant='ChatGPT',
         what='orders, refunds, fees and payouts',
         status='The Aggregate app for Shopify is in Shopify App Store review; one-click installs open once it is approved. Until then you can connect your store with your own Shopify app, as below.',
         connect='Open **Workspace → Connections → + More connections → Shopify Payments** and follow the three steps shown: in your Shopify admin, create an app with only the two read scopes listed, install it on your store, then paste its client ID, client secret and your .myshopify.com domain. Once the App Store listing is approved, you can install Aggregate from the Shopify App Store instead.',
         signin="Shopify's own admin", scope_note=' (Aggregate asks Shopify only for read access.)',
         selfhost_need='Shopify app or a custom app token for your store',
         qs=[('How much did the store take in last month after refunds and fees?', 'query_transactions'),
             ('Which Shopify payouts have not reached the bank yet?', 'list_review_items'),
             ('What is our profit and loss for the store this quarter?', 'get_reports'),
             ('How do this month\'s sales compare with last month?', 'query_transactions'),
             ('How much cash do we have across Shopify and the bank?', 'get_overview')]),
    dict(slug='connect-bank-accounts-to-claude', title='Connect bank accounts and cards to Claude', source='your bank accounts and cards', source_short='bank', assistant='Claude',
         what='balances and transactions from checking, savings and credit card accounts',
         status='Bank connections on the hosted version go through Plaid, which is in Plaid\'s production review. Until it is approved, you can upload statement files (CSV, OFX, QFX or QBO, or PDF statements: 11 known bank layouts import automatically when they reconcile, and any other PDF is kept for your AI to read) or connect through SimpleFIN Bridge, a separate paid service that links most US banks.',
         connect='Open **Workspace → Connections → + More connections**, choose your bank, and sign in to it in Plaid\'s window. Before connecting any account, Aggregate checks it\'s you with a passkey or a code sent to your email.',
         signin="your bank's own page, inside Plaid's window", scope_note=' (Bank connections are read-only.)',
         selfhost_need='Plaid account, a SimpleFIN Bridge token, or statement files',
         qs=[('How much cash do I have across all my accounts right now?', 'get_overview'),
             ('What did I spend on restaurants in the last three months?', 'query_transactions'),
             ('Which subscriptions am I paying for, and did any price go up?', 'list_recurring'),
             ('When are my credit card payments due, and what are the minimums?', 'get_liabilities'),
             ('What money is coming in and going out over the next 30 days?', 'list_upcoming')]),
    dict(slug='connect-deel-to-claude', source='Deel', source_short='Deel', assistant='Claude',
         what='what you pay Deel for contractors and EOR employees, split into worker cost and Deel fees',
         status='Live on the hosted version. You connect with a Deel organization token (scope accounting:read), not a sign-in window.',
         connect='In Deel, create an organization token with the `accounting:read` scope ([Deel\'s guide](https://developer.deel.com/docs/api-tokens-1)). Then open **Workspace → Connections → + More connections → Deel** and paste it.',
         signin='Deel itself (you create the token there and paste only the token)', scope_note=' (The token has the read-only accounting scope.)',
         selfhost_need='Deel organization token',
         qs=[('How much did we spend on contractors through Deel last quarter?', 'get_payroll'),
             ('How much did we pay Deel in fees this year?', 'query_transactions'),
             ('When is the next payroll, and roughly how much will it be?', 'list_upcoming'),
             ('How did payroll cost change compared with last month?', 'get_payroll'),
             ('How many months of runway do we have at the current payroll?', 'get_metric')]),
    dict(slug='connect-bank-statements-to-claude', title='Connect bank statements to Claude', source='bank statements (CSV, OFX or PDF)', source_short='statements', assistant='Claude',
         what='transactions and balances from statement files you upload, plus PDFs and photos of receipts and bills',
         status='Live on the hosted version and when self-hosted. No bank connection needed.',
         connect='Open **Workspace → Add anything → Upload a file**, choose the company, and upload CSV, OFX, QFX, QBO or camt.053 files. PDF statements in 11 known bank layouts import automatically when their rows reconcile to the opening and closing balances; any other PDF, and photos, are kept as documents your AI can read and record. See [Known limits](limits.md).',
         signin='nowhere: you upload files you already have', scope_note='',
         selfhost_need='statement files',
         qs=[('How much did I spend each month this year, by category?', 'query_transactions'),
             ('Which months of each account are missing statements, or don\'t add up?', 'get_coverage'),
             ('Which accounts haven\'t been updated in the last month?', 'list_accounts'),
             ('Read the receipts I uploaded and tell me which ones aren\'t recorded yet.', 'list_documents'),
             ('What were my five largest expenses last quarter?', 'search_transactions')]),
]

def full(p):
    if 'base' in p:
        b = next(x for x in PAGES if x['slug'] == p['base'])
        return {**b, **p}
    return p

def render(p):
    a = p['assistant']
    owner = {'Claude': 'Anthropic', 'ChatGPT': 'OpenAI'}[a]
    title = f"Connect {p['source'].split(' (')[0][0].upper() + p['source'].split(' (')[0][1:]} to {a}"
    title = p.get('title', title)
    qs = '\n'.join(f'{i}. *"{q}"* (uses `{t}`)' for i, (q, t) in enumerate(p['qs'], 1))
    brings = ''
    if p.get('brings'):
        brings = '## What it brings in\n\n' + '\n'.join(f'- {b}' for b in p['brings']) + f"\n\n{p['not_brought']}\n\n"
    return f'''# {title}

**Short answer:** connect {p['source']} to Aggregate, then add Aggregate to {a} with one link
(`{LINK}`). {a} can then answer questions about your {p['what']}, using one ledger that also holds your other
accounts and companies. Aggregate only reads from {p['source_short'] if p['source_short'] not in ('statements', 'bank') else ('your bank' if p['source_short'] == 'bank' else 'your files')}, it can never move money, and you
choose exactly what {a} can see.

**Status:** {p['status']}

{brings}## Set it up

### 1. Connect {p['source_short'] if p['source_short'] not in ('bank', 'statements') else p['source']} to Aggregate
Sign up at [app.aggregate.finance](https://app.aggregate.finance) (free during beta). {p['connect']}

### 2. Add Aggregate to {a}
{ASSISTANT[a]}

## Five questions to try

{qs}

{a} answers from Aggregate's ledger, where every payment is counted once (a payout and the bank deposit it becomes are
matched, not added twice) and balances are checked against the source. Each answer can be traced to the records
behind it.

{FAQ.format(signin=p['signin'], assistant=a, assistant_owner=owner, source_short=p['source_short'] if p['source_short'] not in ('bank', 'statements') else ('bank accounts' if p['source_short'] == 'bank' else 'files'), scope_note=p['scope_note'], selfhost_need=p['selfhost_need'])}
## Related

- [Connect your AI to Aggregate](../connect-your-ai.md): every assistant, plus bots and scripts
- [Prompt recipes](../recipes.md)
- [How Aggregate compares](README.md#comparisons)

*Last checked {p.get('checked', CHECKED)}.*
'''

os.makedirs(OUT, exist_ok=True)
for p in PAGES:
    p = full(p)
    open(os.path.join(OUT, p['slug'] + '.md'), 'w').write(render(p))
    print('wrote', p['slug'])
