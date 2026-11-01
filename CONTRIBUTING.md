# Contributing to Aggregate

Thanks for helping. Aggregate handles people's money, so we care most about two things: numbers that are right, and
changes that are easy to review.

## Good first contributions

- **Fix a connector.** Most connectors are built from provider docs and haven't met every real account yet. If yours
  looks wrong (a sign flipped, a payout counted twice), an issue with a redacted sample is gold.
- **Add a connector.** Each provider is one package in `packages/connectors/*`, built on the SDK in
  `packages/connectors/sdk`. Copy a similar one, add fixtures, and register it in `packages/connectors/registry`.
- **Docs and wording.** Plain words beat jargon everywhere, including error messages.

Issues labeled **good first issue** are small and say how you'll know you're done. During Hacktoberfest, merged pull
requests count; please don't send drive-by changes (whitespace, renames) — they're closed as spam.

## Running it locally

```sh
npm install
npm run -s keygen > .env
npm run build -w @agfn/web
npm run dev                 # http://localhost:8787, sign-in links print to the console
```

After signing in once, load three made-up companies to explore:

```sh
npm run agfn -- demo --email you@example.com
```

Before opening a pull request:

```sh
npm run typecheck
npm test
```

Both must pass. Don't skip or loosen tests to make them green; if a test is wrong, say why in the PR.

## Rules of the road

- **Never move money.** Connectors are read-only at the source, and Aggregate never sends payments, invoices or emails
  on anyone's behalf. Pull requests that change this won't be merged.
- **Every amount must reconcile.** Ledger changes need tests that prove totals still balance.
- **No real financial data** in fixtures, screenshots or issues. Use made-up companies.
- **Small pull requests**, one change each, with a sentence on why.

## License and CLA

Aggregate is [AGPL-3.0](LICENSE). On your first pull request, a bot will ask you to sign our
[Contributor License Agreement](docs/legal/CLA.md) by posting one comment. You keep the copyright in your work; the agreement lets
the project use your contribution and, if it ever needs to, offer the code under other license terms too. If you
contribute on behalf of your employer, have them sign the entity part once (details in [the agreement](docs/legal/CLA.md)).

## Security

Found a vulnerability? Please don't open an issue. Follow [SECURITY.md](SECURITY.md) instead.
