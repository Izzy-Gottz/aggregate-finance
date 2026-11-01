# Security

Aggregate holds bank connections and financial records, so we take reports seriously.

## Reporting a vulnerability
Please don't open a public issue. Email **security@aggregate.finance** with steps to
reproduce. We aim to acknowledge within 2 business days and keep you updated until it's fixed. We won't take legal action
against good-faith research that avoids privacy violations, data destruction and service disruption.

## What we promise
- Aggregate never moves money and never sends anything on your behalf. No tool can pay, transfer or email.
- Provider secrets (bank tokens, API keys) are encrypted with a per-record key wrapped by a master key that is kept
  outside the data directory. A copy of your database or backups alone can't decrypt them.
- Every AI connection is scoped to the companies and data you choose, can be paused or revoked at any time, and every
  question it asks is logged.

## Design notes
See [docs/security/threat-model.md](docs/security/threat-model.md).
