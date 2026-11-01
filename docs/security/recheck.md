# Confirming it's you (re-checks)

Some actions need a fresh "it's you" even inside a signed-in session, because a stolen session cookie must not be
enough for them:

- connecting a bank or any financial account;
- giving an AI access, or widening what it can do;
- deleting the workspace or your account.

## How the check works

| You have | The check | Valid for |
|---|---|---|
| A passkey on this device | Face ID, fingerprint or device PIN | 10 minutes |
| A passkey, but not on this device (new or lost phone, another computer) | **Use email instead**: a one-time link to your account's email | 10 minutes |
| No passkey | A one-time link to your account's email (or any sign-in in the last 10 minutes) | 10 minutes |

The email link (`POST /api/recheck/email`, `apps/server/src/recheck.ts`):

- goes only to the account's own address, never one typed in;
- is 32 random bytes, stored only as a hash, expires in 10 minutes and works **once**;
- can be opened on any device: it confirms you, then you go back and try again;
- is rate-limited: the sign-in email limit (5 per address per 15 minutes) plus 5 re-check links per person per hour;
- is written to the activity log of every workspace you're in ("Confirmed it's them with an email link instead of a
  passkey"), so an owner can see it;
- is never available to reviewer demo accounts.

A plain email sign-in does **not** count as a passkey check for someone who has a passkey. Only the explicit,
one-time re-check link does.

## The trade-off

Without the email fallback, losing or replacing your phone would lock you out of connecting accounts, managing AI
access and deleting your data, with no way back. With it, **your email inbox is a recovery factor**: someone who
controls both your signed-in session and your inbox can complete these actions. Your inbox already gates signing in
(sign-in is by emailed link), so this adds no new way in for someone who has only your inbox: they could sign in and
request the link anyway. What a passkey still adds is protection against a stolen session alone, and against phishing
of the sign-in itself.

So: protect the email account (a strong password and two-step verification at your email provider). After using the
email fallback on a new device, add a passkey there too (the app offers it right away).

## The code next to the link (sign-in and re-check emails)

Email links often open somewhere else: a phone's mail app, or another default browser. That signs in (or confirms)
that browser and leaves the one that asked still waiting. So every sign-in and re-check email also carries a 6-digit
code (`apps/server/src/app.ts`, `packages/auth/src/email-codes.ts`, migration 0509):

- **Sign-in:** `POST /api/signin/code {code}` from the waiting "Check your email" page. It works only in the browser
  that asked: asking sets an httpOnly nonce cookie (`agfn_signin_nonce`, path `/api/signin`, 10 minutes), and the code
  is looked up by that nonce. Success verifies the same magic link server-side, so this browser gets the session and
  the link is spent (using either one uses both).
- **Re-check:** `POST /api/recheck/code {code}` from the signed-in session that asked. It records the same `email_link`
  re-check as opening the link. Never available to reviewer accounts.
- **Limits:** 10 minutes (with the link), once, 5 tries per email (then that email is spent), plus per-IP and global
  rate limits for sign-in codes and per-person limits for re-check codes. Codes are 6 random digits stored as salted
  hashes and compared in constant time. With 5 tries per email and 5 emails per address per 15 minutes, a blind guess
  succeeds about once in 40,000 windows (about 1.1 years of nonstop trying against one address), and each try needs a
  fresh email sent to the real owner.
- **No cross-device approval.** We don't do "approve the sign-in on your other device" polling: an attacker could start a
  sign-in and talk someone into approving it. The email says to type the code only on a page you opened yourself and
  never to read it to anyone.

Tests: `apps/server/src/email-codes.test.ts` (two browsers, link-first, brute force, invites without a code, re-check).
