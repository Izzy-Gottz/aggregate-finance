# Aggregate Stripe App (manifest only)

A Stripe App with no UI: it exists so people can connect Stripe to Aggregate in one click (Stripe Apps OAuth,
read-only). The connector lives in `packages/connectors/stripe`; this folder only holds what Stripe needs to register
the app. Owned by Aggregate's own Stripe account (not a portfolio company's).

- Upload / new version: `stripe apps upload` from this folder (Stripe CLI signed in to the Aggregate account).
- After upload: Dashboard → Apps → Aggregate → Settings shows the OAuth client id (`ca_…`) → `STRIPE_APP_CLIENT_ID`.
  `STRIPE_APP_SECRET_KEY_LIVE` is the Aggregate account's own live secret key (`sk_live_…`) and
  `STRIPE_APP_SECRET_KEY_TEST` its test key (`sk_test_…`). Stripe only accepts the key for the install's mode, so
  test-mode installs need the test key. Either one alone works for that mode; the older `STRIPE_APP_SECRET_KEY` is
  still read as the live key.
- Test first with the test-mode install link (External test tab), installing on our own test account.
- Permissions must match what the connector reads; adding one later means every install re-consents.

Stripe's review requirements: [App Review](https://docs.stripe.com/stripe-apps/review-requirements).
