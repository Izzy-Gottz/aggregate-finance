# Security

Aggregate holds bank connections and financial records, so we take reports seriously.

## Reporting a vulnerability
Please don't open a public issue. Email **security@aggregate.finance** with steps to reproduce and the impact, or use
[GitHub's private reporting](https://github.com/Izzy-Gottz/aggregate-finance/security/advisories/new). We aim to acknowledge
within 2 business days and keep you updated until it's fixed. We won't take legal action against good-faith research that
avoids privacy violations, data destruction and service disruption. We don't run a paid bug bounty.

A vulnerability is anything that lets someone read or change data they shouldn't, get around a grant, sign-in or the
read-only rules below, or reach secrets. That covers the hosted service, the code in this repository and its releases.
Bugs in a wrong number are welcome as ordinary issues, unless they expose someone else's data.

## What happens next
We confirm the problem, fix it, and aim to publish the fix within 60 days of your report, sooner for anything serious. We
credit you if you'd like. Fixes that matter to self-hosters are listed in [CHANGELOG.md](CHANGELOG.md). Please give us
that time before you publish details.

## Supported versions
Only the latest release and the current `main` get security fixes. The hosted service always runs a recent `main`.

## What we promise
- Aggregate never moves money. It emails someone else only when you send an invite. No tool can pay, transfer or email.
- Provider secrets (bank tokens, API keys) are encrypted with a per-record key wrapped by a master key that is kept
  outside the data directory. A copy of your database or backups alone can't decrypt them.
- Every AI connection is scoped to the companies and data you choose, can be paused or revoked at any time, and every
  question it asks is logged.

## Design notes
See [docs/security/threat-model.md](docs/security/threat-model.md).
