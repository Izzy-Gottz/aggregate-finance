# Etsy: what Aggregate reads and how it's kept

The term 'Etsy' is a trademark of Etsy, Inc. This application uses the Etsy API but is not endorsed or certified by Etsy, Inc.

Aggregate is a bookkeeping tool for one seller's own money. With Etsy, it checks that what Etsy paid out from your shop
matches the deposits that reached your own bank, next to your own books. It only reads. It can't create or change
listings, orders or messages, and it can't move money.

Etsy isn't offered on the hosted app right now. This page describes the connection as it's built.

## What it asks Etsy for

Two read-only permissions, and nothing else:

- `transactions_r`: your shop's payment account entries (sales, Etsy's fees, refunds, the sales tax Etsy collects and
  remits, and deposits to your bank).
- `shops_r`: your shop's name and currency.

Aggregate never asks for `email_r`, `address_r` or `buyer_email`, and never for any permission that writes. Every call it
makes to Etsy is a read: the connection refuses anything else before a request is sent.

## What it keeps

For each payment account entry: its amount, the running balance after it, the currency, the date, the kind of entry, and
Etsy's ids for the entry and the order or payment it belongs to. From your shop: its name (to label the connection) and its
currency.

## What it never reads or keeps

- **Buyer emails.** Aggregate doesn't request access to buyer emails and never stores them.
- **Anything else about buyers:** no names, addresses, messages or buyer ids.
- **Free text:** no entry descriptions and no refund reasons.
- **Listings, inventory and reviews.** The connection doesn't read them.

## Your data stays yours

- **Kept apart per seller.** Your Etsy data belongs to your own Aggregate workspace. Every read is limited to that
  workspace, and the database enforces this with row-level security, so no other seller or account can see it. Aggregate
  never combines one seller's data with another's.
- **Only for your own books.** It's used to show you your own payouts, fees and deposits. You can ask your own AI
  assistant about your own books.
- **Never sold, never used to train AI models** ([privacy policy](/privacy)).
- **Your sign-in stays private.** You sign in to Etsy yourself, and Aggregate never sees your Etsy password. The access
  Etsy gives Aggregate is stored encrypted.

## How fresh it is

- Etsy data refreshes at least every 24 hours (Aggregate reads it about every hour).
- If a refresh fails, current Etsy figures (your Etsy balance, and totals for the current period) are marked out of date
  and left out until the next successful sync.
- Closed past months stay as recorded.

## Disconnecting

Disconnect Etsy in Aggregate at any time. Everything the connection brought in is deleted then, not just hidden. To end
Aggregate's access on Etsy's side too, remove Aggregate from the apps allowed on your Etsy account. Deleting your
Aggregate account deletes all of it.

## Questions

Email support@aggregate.finance. Also see the [privacy policy](/privacy), [terms](/terms) and
[security](/security).
