---
title: Security
status: final
updated: 2026-11-01
---

# Security

Aggregate connects to your bank, payments and accounting accounts and lets the AI you choose read them. This page says,
in plain words, how that access is limited and how your data is protected. It only describes what is built today;
where something is still planned, it says so.

## Aggregate can't move money

Aggregate only reads. It asks banks and providers for balances, transactions, invoices, bills and reports. Where a
provider lets you choose, we ask for a read-only key, and Aggregate never calls anything that pays, transfers or sends.
No tool in Aggregate, for you or for an AI, can move money or send anything on your behalf.

Bank connections go through Plaid or SimpleFIN: you sign in with your bank on their screen, never on ours, and we never
see your bank password.

## Your provider keys are encrypted

Bank tokens and API keys are encrypted before they are stored. Each one gets its own key (AES-256-GCM), and that key is
itself encrypted with a master key that is kept outside the database. A copy of the database, or of a backup, can't
decrypt them on its own.

When you disconnect, Aggregate revokes its access at the provider where the provider allows it (for Plaid, it removes
the connection), and the stored token is wiped.

## A fresh check protects the sensitive steps

Signing in uses a passkey (Face ID, a fingerprint or your device PIN) or a one-time email link that expires in 10
minutes. There are no passwords to steal or reuse.

Connecting a bank or other money account needs a fresh check that it's you, made in the last 10 minutes: your passkey,
or a one-time link emailed to your account's own address (it works once and expires in 10 minutes). The same check is
asked for before creating AI access, widening what an AI can see, and deleting a workspace or an account. Adding a
passkey is recommended, not required. Because the email link is a way in, protect your email account with two-step
verification.

## You decide what each AI can see and do

Each AI you connect gets its own access, and you choose:

- which companies it can see (or Personal),
- which kinds of data (cash, invoices, payroll and so on),
- whether it can only read or can also add records, and for how long.

You can pause or revoke any AI at any time. Every question an AI asks, and every change it makes, is written to an
activity log you can read.

Changes an AI adds are labelled with which AI made them and can be undone for 30 days. Some changes always wait for a
person to approve them first: closing or reopening the books, and any change whose text looks like it was planted by a
document the AI read (a prompt-injection attempt). You can also have every AI change wait for your review. Each AI
has a daily limit on changes, and a change that moves a company's cash by a large share raises an alert.

## Each workspace is kept apart

Every request is checked against the person making it and the companies they can see, and every database query is
limited to that person's workspace.

In Postgres, row-level security adds a second wall underneath, so a query that forgot that limit would return nothing
rather than another workspace's data. It is on.

The checks above are exercised by an automated "red team" test suite that tries to cross workspaces, widen an AI's
access, reuse keys, forge webhooks, smuggle instructions into uploads and inbound email, and abuse export links.

## Backups, and deleting your data

Backups are made nightly and encrypted with the same master key before they leave the server. Encrypted backups are
kept for 25 days, so deleted data is gone from backups within 30 days. Backups and your uploaded files are stored in
separate places with separate keys, so a key that can read files can't delete backups.

You can export everything at any time. When you delete a workspace, its connections are revoked first, then its files
and every record are deleted right away.

## Where your data is stored

Aggregate's hosted app runs on Fly.io in Ashburn, Virginia (US). Its database is Neon Postgres in AWS us-east-1, and
uploaded files and nightly backups are kept in Cloudflare R2. All traffic is over HTTPS. Provider tokens and keys are
encrypted as described above, and backups are encrypted before they leave the server.

## What we keep, and for how long

We keep what your connections bring in (accounts, balances, transactions, invoices, bills, payroll and investment
records) for as long as your workspace exists, so the numbers stay reconciled. The provider's raw responses for a
disconnected connection are deleted 30 days after you disconnect it. Deleting a workspace deletes its records and
files right away, and they age out of backups within 30 days.

## Who at Aggregate can see your data

Today only the founder can reach the production systems: directly, or through AI tools the founder runs under the
founder's own accounts. The accounts that reach production are protected by two-step sign-in where the provider
offers it. Customer data is looked at only to fix a problem a customer reported, to respond to a security incident,
or when the law requires it. The app's activity log records each question an AI connection asks and every change
made through Aggregate; direct database access by the founder isn't logged that way today. If anyone else ever gets
access, it will be written down, limited to what the job needs, and removed when it's no longer needed.

## Open source

Aggregate is licensed under the GNU AGPL v3, and its code is public at https://github.com/Izzy-Gottz/aggregate-finance.
Anyone can read the code that handles your data, and you can run it on your own server instead of ours, with your own
credentials for the services you connect.

## What we don't claim

We don't hold a SOC 2 report or other certification today. We don't use phrases like "bank-level security". We'd
rather tell you exactly what is built.

## Reporting a problem

If you find a security problem, please email **security@aggregate.finance** rather than posting it publicly or opening a public issue. Tell
us how to reproduce it. We aim to reply within 2 business days and will keep you updated until it's fixed. We won't take
legal action against good-faith research that avoids privacy violations, data destruction and service disruption.
