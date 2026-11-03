---
description: When to upload a CSV to Aggregate, when not to, and how to avoid counting the same money twice.
updated: 2026-11-02
---

# Upload a CSV without counting money twice

**Short answer:** if a bank account is connected, don't also upload its CSV. Upload a CSV only for an account that isn't
connected, or for months the connection doesn't reach. For later exports, pick the same account each time, then check
**Review**.

Aggregate doesn't remove duplicates on its own. It suggests matches, and you decide.

## When to upload

- **The account isn't connected.** The file is the only copy of that money in Aggregate.
- **The connection doesn't go back far enough.** Upload only the older months.
- **Your bank doesn't connect.** Upload its statements instead.

## When not to upload

- **The bank is already connected.** The same transactions would be in Aggregate twice.
- **A second copy of the same months in a new account.** Aggregate treats it as a different account, so the money counts
  in both.

## How to upload

1. Open **Workspace → Add anything → Upload a file**.
2. Choose the company.
3. Upload your CSV. OFX, QFX, QBO and camt.053 files work the same way.
4. If this isn't your first file for the account, say which account it belongs to. Don't create a second account for the
   same bank.
5. Check **Review**.

Rows repeated across two files of the same account count once, so an export can overlap the last one.

A bank's CSV doesn't include the card or account number, so two cards from the same bank can land in one account. Choose
the account when Aggregate asks, or upload OFX, QFX or QBO files, which include the number.

## What Review shows you

Aggregate compares each uploaded row with your connected accounts. If the same amount and a similar payee appear within
2 days, it suggests a match in **Review**. It never matches them on its own.

- Confirm it only if it's truly the same money.
- If you reject it, both rows count.

While a suggestion waits, the uploaded copy normally isn't counted.

## What it can't catch

The amount has to match exactly and the payee has to look similar. If your CSV describes a payment very differently from
your bank connection, you won't get a suggestion, and both rows count with no warning. That's the main reason not to
upload a connected bank's CSV.

## Payment apps and platforms

Files from apps such as Airbnb, Venmo, Upwork, DoorDash and Uber aren't tested yet, so we can't say they import correctly.
Their money usually lands in your bank too, so a connected bank and an earnings file can show the same money twice. Your
bank connection already shows those deposits.

## Related

- [Connect bank statements to Claude](connect-bank-statements-to-claude.md)
- [Known limits](limits.md)
- [How we count cash, burn and runway](definitions.md)

*Last checked 2026-11-02.*
