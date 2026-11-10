---
title: Privacy Policy
status: final
updated: 2026-11-06
---

# Privacy Policy

Aggregate ("we") puts the money of your companies in one place. This page says what we collect, why, where it lives, and how to get rid of it. It describes the hosted service at aggregate.finance. If you run Aggregate yourself, your data stays on your own server and this policy covers none of it.

Aggregate is operated by Aggregate Finance LLC, a New Jersey limited liability company ("we"), 1401 Pennsylvania Ave, Wilmington, DE 19806-4124, USA. Contact: privacy@aggregate.finance.

## What we collect and why

- **Your sign-in details.** Email address, name, and passkeys or Google/Apple sign-in if you use them. We use them to sign you in and to send sign-in links, invites and the notices you turn on.
- **Financial data you connect.** When you connect a bank, card, payment processor, payroll or accounting service (through Plaid or a direct connection), we receive accounts, balances, transactions, invoices, payroll totals and similar records. We use them to show you your numbers, and for nothing else. We handle QuickBooks data for you, at your direction. We don't process it on Intuit's behalf.
- **What you add.** Entries, notes, buckets, rules, the cap table, and documents you upload (or email in, on a self-hosted copy) (receipts, bills, statements), including the text we read from them.
- **AI activity.** When you connect an AI assistant or agent (through a connector or an agent key), we log every call it makes: which tool, when, which companies, whether it worked, plus the network address and app name it called from. Writes keep a record of who made them, so you can review and undo them.
- **People you invite.** If you use Invite someone, we send that address one fixed email from Aggregate with your first name and a sign-up link. You can't add a message, and we send nothing if the address already has an account, got an invite in the last 30 days, or asked not to get invites. We don't keep the address. We keep a keyed hash of it for 30 days to refuse repeats, then delete it, or sooner if you delete your account. To stop abuse, we also keep a keyed hash of your network address with each invite for one day. Resend handles the email and sees the address to deliver it. The person isn't added to any list. The email has a "Don't send me invites" link; using it keeps only a keyed hash of the address, until they undo it. If they open the sign-up link, a cookie remembers it for 30 days, and if they sign up we record that you invited them. Deleting your account deletes that record.
- **Security records.** Sign-in sessions keep the network address and browser they came from. Invites, exports and permission changes are logged with who made them and when. When our systems flag a source as a likely scanner or abuser, we log its requests for up to an hour after it's flagged: a keyed hash of the network address (never the address itself), with each request's method, path, result and timing. These records are deleted with our hosting provider's logs after 7 days. We never log the query string, request headers or contents. These protect your account.

We don't collect anything beyond this. The marketing site (aggregate.finance) counts visits with Cloudflare Web Analytics, which sets no cookies and doesn't identify individual visitors. The app itself has no ads, analytics or tracking scripts. Plaid's sign-in window, when you open it, is run by Plaid. We use cookies only to keep you signed in.

## What we never do

- We never sell your data or share it for anyone's marketing.
- We never use your data to train AI models, including what we read from your banks and from apps like QuickBooks and Xero, and we never sell it. When you connect an AI app, what it receives follows that AI provider's terms ([AI clients](#ai-clients)).
- Aggregate never moves money. It reads your accounts and keeps records; it can't pay or transfer. It emails someone else only when you send an invite.

## Where it is stored and how it is protected

- **Hosted:** on our servers and our file storage, in the United States (Fly.io for the app, Neon for the database, Cloudflare R2 for files and backups).
- **Self-hosted:** on your server. We never see it.
- Connection tokens and other secrets are encrypted with envelope encryption: each secret has its own AES-256-GCM key, which is itself encrypted with a master key kept outside the database.
- Traffic is encrypted in transit (HTTPS).
- Only the people who run the hosted service can reach the servers, and they look at your data only when needed to keep the service working or when you ask for help. Today that is only the founder. Access to the servers needs multi-factor sign-in, and every action inside Aggregate is recorded in a tamper-evident activity log.
- People see only the companies and data their role allows. Your Personal space is private to you unless you choose to share it.

## AI clients

When you connect an AI app (Claude, ChatGPT, an agent key), we send it the data you choose, including numbers from apps you connected like QuickBooks, so it can answer you. The AI app is run by its own provider (for example Anthropic or OpenAI), and what it receives is handled under that provider's terms, not ours. You see this before you allow it, and we keep a record of what you agreed to and when.

An AI you connect sees only what you grant it: which companies, which kinds of data, and whether it may add records. You can change or revoke that at any time in Settings → AI, or pause every AI with one switch. Once you revoke access, the AI gets nothing more. What an AI already received is governed by that AI provider's own terms.

## Plaid

We use Plaid to connect many banks and cards. When you connect an account through Plaid, Plaid's End User Privacy Policy applies to the data Plaid collects: https://plaid.com/legal/#end-user-privacy-policy

You sign in with your bank on Plaid's screen, never on ours, and we never see your bank password.

## Who processes data for us

| Provider | What for |
|---|---|
| Plaid | Connecting banks and cards |
| Other services you connect (Stripe, QuickBooks, Mercury and others) | Reading the data you chose to connect |
| Resend | Sending sign-in links, invites and notices |
| Fly.io, Neon, Cloudflare (R2 and DNS) | Running the service, the database, storing files and backups, and routing traffic |
| Frankfurter (frankfurter.dev) | Currency exchange rates. Only currency codes and dates are sent, never your data. |

BILL's sync token can technically edit records in your BILL account but can't pay anyone or move money. Aggregate only reads; our code makes no changes in BILL.

## Keeping and deleting your data

- **Disconnect** a connection and we stop syncing. When you disconnect, we revoke our access at the provider where it allows that, and tell you if there's a step for you to do there.
- For QuickBooks, FreshBooks, Wefunder and Shopify (when it's the store's last connection in Aggregate), disconnecting (or removing Aggregate inside that service) also deletes what that connection brought in.
- **Export** everything in Preferences → Your data → Export everything, as one file.
- **Delete your workspace** in Preferences (owners only). This revokes our access at each provider where it allows that, tells you of any step left for you there, and erases all of the workspace's records, documents and AI activity. Your sign-in account stays so you can keep using other workspaces. You can also delete your sign-in account entirely in Preferences; if you are the only owner of a workspace, you first make someone else an owner or delete the workspace. When you delete your sign-in account, we remove your name, email address, and sign-in methods (passkeys and any Google/Apple link). We keep one non-identifying internal reference to the deleted account so that past records and activity history still make sense; it contains no personal information.
- Encrypted backups are kept for 25 days, so deleted data is gone from backups within 30 days.
- If we confirm that someone got into your data without permission, we'll email the owners of the affected workspaces promptly, and as the law requires: what happened, what data was involved and what to do next. We'll keep you updated until it's resolved. Questions about an incident go to security@aggregate.finance.
- We keep your data while your workspace exists. We don't delete inactive workspaces automatically; if a workspace hasn't been used for 90 days, we email its owners in case they want to disconnect or delete it.

## Your rights

You can see, export, correct and delete your data yourself, as described above. For anything else, or to make a request under laws like GDPR or CCPA, write to privacy@aggregate.finance. California residents have rights under the CCPA, including to know, delete and correct personal information; we do not sell or share personal information as those terms are defined there. Aggregate is offered to people and businesses in the United States.

## Children

Aggregate is for businesses and adults. It is not meant for anyone under 18.

## Changes

If we change this policy, we'll update the date above and tell workspace owners by email before a material change takes effect.

## Self-hosting

Aggregate is open source under the GNU AGPL v3 (https://github.com/Izzy-Gottz/aggregate-finance). If you run it yourself, you use your own credentials with the banks and services you connect, you control the data, and you are responsible for your own privacy policy toward the people who use your copy. This policy covers only our hosted service.

## Contact

privacy@aggregate.finance · 1401 Pennsylvania Ave, Wilmington, DE 19806-4124, USA
