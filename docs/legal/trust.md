---
title: Trust
status: final
updated: 2026-11-02
---

# Trust

Aggregate is operated by Aggregate Finance LLC, a New Jersey limited liability company. It connects to your bank, payments and accounting accounts and gives your numbers to the AI you choose. This page says what we can and can't do, and what we don't have yet. For detail, read [Security](/security) and [Privacy](/privacy).

## What we read, and what we can't do

Aggregate reads balances, transactions, invoices, bills and reports. It can't move money. No tool in Aggregate, for you or for an AI, pays or transfers. It emails someone else only when you send an invite.

Where a provider lets you choose, we ask for read-only access. QuickBooks, BILL, Lemon Squeezy and Expensify don't offer that, so what they give us could do more than read. Aggregate only reads from all four, and BILL's token can't pay anyone or move money.

You sign in with your bank on Plaid's or SimpleFIN's screen, and we never see your bank password.

We don't sell your data, show ads, or train AI models on it. Our server doesn't call an AI model. Your data goes to the AI you connect, and that provider's terms apply to what it receives.

## Security controls

- **Provider keys:** encrypted before they're stored, each with its own key (AES-256-GCM), wrapped by a master key kept outside the database.
- **Traffic:** HTTPS only.
- **Sign-in:** passkeys or a one-time email link or code, Google or Apple. No passwords.
- **Sensitive steps:** connecting an account, giving an AI access, and deleting all need a fresh check that it's you.
- **Each AI:** gets its own access, limited to the companies and data you choose, read-only by default. You can pause or revoke it. Every question it asks is logged, and you can read the log.
- **Separation:** every request is checked against your workspace, and Postgres row-level security adds a second check. This guards against mistakes in our code; it doesn't stop someone who could run their own SQL as the application.
- **Backups:** nightly, encrypted before they leave the server, kept 25 days.
- **Our own access:** when we run a command on one workspace's data from our server, we record who ran it and why, and that workspace's owners and admins can see it through their AI. Direct database access isn't logged this way yet.
- **Testing:** automated red-team tests try to cross workspaces, widen an AI's access, and smuggle instructions through documents. They run on every code change. CodeQL and dependency checks scan the public code.
- **Open source:** the code is public under the AGPL v3 at [github.com/Izzy-Gottz/aggregate-finance](https://github.com/Izzy-Gottz/aggregate-finance).

## Reviewed by

These are checks other companies ran on Aggregate, or steps we're still waiting on. None of them is a certification, and none of these companies endorses us. Each one covers only what it says.

| Company | What happened | Date |
|---|---|---|
| Plaid | Aggregate runs in Plaid's production environment. We submitted Plaid's security questionnaire, which Plaid requires for OAuth banks such as Chase. | October 2026 |
| Stripe | Available on the Stripe App Marketplace, after Stripe's app review of version 1.0.3. | October 26, 2026 |
| Shopify | Available on the Shopify App Store, after Shopify's app review. | October 22, 2026 |
| Mercury | Mercury's compliance team approved our demo and issued production access. We signed their data access agreement. We aren't a Mercury partner, and we haven't yet tried the connection with a real Mercury account. | October 28, 2026 |
| Wefunder | Wefunder approved our app. | October 15, 2026 |
| Intuit | We completed Intuit's app assessment questionnaire and Intuit confirmed it received it. We have no review result. | October 11, 2026 |
| Deel | Submitted for Deel's App Store review. Still under review. | October 16, 2026 |

Last checked: November 1, 2026.

## Voluntary data commitments

In 2024 the US Consumer Financial Protection Bureau wrote a rule for companies that collect people's bank data with their permission (12 CFR 1033, section 1033.421). As of November 1, 2026, a federal court has barred the agency from enforcing the rule while it reconsiders it, and a new version has been proposed. We use the 2024 duties as a guide because they're a clear public standard, not because a regulator has reviewed us.

**What we do today**

- We collect only what we need to show you your numbers, and we use it only for that.
- We don't sell your data, use it for targeted advertising, or use it to sell you other companies' products.
- You can cut off access as easily as you gave it: Disconnect for a provider, Revoke for an AI.
- Disconnecting stops collection right away and wipes our stored token.

**What we don't do yet**

- **Yearly re-consent.** AI access expires after 90 days. Provider connections keep syncing until you disconnect them, so we don't yet ask you to renew them each year.
- **Removing data after you disconnect.** The rule says to stop keeping data once it's no longer needed. Past transactions stay in your books after you disconnect most providers, so your history stays complete. Deleting your workspace removes them.
- **Contracts with everyone who receives data.** Your AI app gets what you grant it under that provider's own terms, not a contract with us.

## Vendors we use

| Vendor | What for | Data it handles | Where | Data terms |
|---|---|---|---|---|
| Fly.io | Running the service | All of it, while processing | Ashburn, Virginia | In place |
| Neon | Database | All of it | AWS us-east-1 | In place |
| Cloudflare | Files, encrypted backups, DNS, email routing, website analytics | Documents, encrypted backups, website traffic | | In place |
| Resend | Sign-in links, invites, notices | Email addresses, links, summary figures in the weekly email | | In place |
| Plaid | Connecting banks and cards | Account details, balances, transactions, holdings | | Being confirmed |
| Google, Apple | Sign in with Google or Apple, if you choose it | Name and email at sign-in | | |
| Vercel | Marketing website | Website traffic only | | |
| Frankfurter | Exchange rates | Only currency codes and dates | | |

Services you connect, such as Stripe, QuickBooks and Mercury, receive the requests needed to read your data. The AI app you connect receives what you grant it, under its provider's terms.

## How long we keep data

| Data | How long |
|---|---|
| Provider tokens and keys | Until you disconnect, then wiped |
| Your records: accounts, transactions, invoices, payroll | While the workspace exists |
| Documents you upload | While the workspace exists |
| Activity log, including AI calls | While the workspace exists |
| AI changes | While the workspace exists; they can be undone for 30 days |
| Raw provider data | While connected, and up to 30 days after you disconnect |
| Export files | Link lasts 1 hour; the file is deleted at your next export |
| Backups | 25 days, so deleted data is gone from backups within 30 days |
| Addresses you invite | Only a keyed hash, for 30 days |
| Server logs | As long as our host keeps them; we haven't set a fixed period yet |

We don't delete inactive workspaces automatically. If a workspace hasn't been used for 90 days, we email its owners. When you delete a workspace, its records and files go right away, and sign-in records go when you delete your account.

## Data agreements

We have data processing terms in place with Fly.io, Neon, Cloudflare and Resend, and we're confirming Plaid's. We don't publish a standard data processing agreement for customers yet. If you need one, write to privacy@aggregate.finance.

## Reporting a security problem

Email **security@aggregate.finance** rather than posting publicly. Tell us how to reproduce it. We aim to reply within 2 business days and will keep you updated until it's fixed.

If we confirm that someone got into your data without permission, we'll email the owners of the affected workspaces promptly, and as the law requires.

## Safe Harbor

This policy covers aggregate.finance, app.aggregate.finance, docs.aggregate.finance and the Aggregate MCP server. It doesn't cover the services customers connect, such as banks, Plaid or accounting apps, or the companies that host us. Use only your own account and test data, and avoid privacy violations, data destruction and service disruption. Our Official Channel is security@aggregate.finance. This text is the [disclose.io](https://disclose.io) Safe Harbor, unmodified.

When conducting vulnerability research, according to this policy, we consider this research conducted under this policy to be:

- Authorized concerning any applicable anti-hacking laws, and we will not initiate or support legal action against you for accidental, good-faith violations of this policy;
- Authorized concerning any relevant anti-circumvention laws, and we will not bring a claim against you for circumvention of technology controls;
- Exempt from restrictions in our Terms of Service (TOS) and/or Acceptable Usage Policy (AUP) that would interfere with conducting security research, and we waive those restrictions on a limited basis; and
- Lawful, helpful to the overall security of the Internet, and conducted in good faith.

You are expected, as always, to comply with all applicable laws. If legal action is initiated by a third party against you and you have complied with this policy, we will take steps to make it known that your actions were conducted in compliance with this policy.

If at any time you have concerns or are uncertain whether your security research is consistent with this policy, please submit a report through one of our Official Channels before going any further.

> Note that the Safe Harbor applies only to legal claims under the control of the organization participating in this policy, and that the policy does not bind independent third parties.

## What we don't have yet

- No SOC 2 report, ISO 27001 or other certification. We're preparing for SOC 2, which means we've written our policies and mapped our controls. No audit has started.
- No outside penetration test.
- Our master key is held as a hosting secret. Moving it to a cloud key service is planned.
- One person runs the company, so no second person reviews code or access.
- The service runs in one US region, with no failover.
- Aggregate is in unofficial beta, with no uptime commitment.

## Badges

These are public checks anyone can re-run. They test web and code hygiene, not a company's whole security. Grades are from November 2, 2026.

| Check | Result | Source |
|---|---|---|
| Mozilla HTTP Observatory | A+ on aggregate.finance, app.aggregate.finance and docs.aggregate.finance | [observatory](https://developer.mozilla.org/en-US/observatory) |
| Qualys SSL Labs | A+ on aggregate.finance, app.aggregate.finance and docs.aggregate.finance | [ssllabs.com](https://www.ssllabs.com/ssltest/analyze.html?d=aggregate.finance) |
| Glama | A for the connector | [glama.ai](https://glama.ai/mcp/connectors/finance.aggregate/aggregate) |
| OpenSSF Scorecard | 7.1 out of 10 | [scorecard.dev](https://scorecard.dev/viewer/?uri=github.com/Izzy-Gottz/aggregate-finance) |
| Cloud Security Alliance | [![CSA STAR Level 1 badge](https://aggregate.finance/brand/badges/csa-star-level-1.png)](https://cloudsecurityalliance.org/star/registry/aggregate/services/aggregate) Listed in the CSA STAR Registry (Level 1 self-assessment, CAIQ) | [cloudsecurityalliance.org](https://cloudsecurityalliance.org/star/registry/aggregate/services/aggregate) |

The CSA listing is our own self-assessment, published on CSA's registry. It isn't an audit or a certification.
