# Information security policy

Status: Approved by the founder 2026-11-01; next review due 2027-11-01.

Owner: the founder. Review date: 2027-11-01.

## Purpose

Say who is responsible for security at Aggregate, how risks are found and tracked, and how the other policies fit together.

## Scope

The hosted service, its cloud accounts, the source code, and the devices and accounts used to run the company. See `README.md`.

## Policy

1. **Responsibility.** The founder owns security and every policy here. There is no board, security officer or independent oversight. Anyone who joins gets written responsibilities before they get access.
2. **What we protect.** Customers' financial data, provider tokens and the keys that protect them.
3. **What we won't do.** Aggregate doesn't move money or send anything on a customer's behalf. We don't sell data, show ads, or train models on it. Our server calls no AI model.
4. **Least access.** People, AI clients and systems get only the access they need (`access-control.md`).
5. **Encryption.** Traffic uses HTTPS and TLS. Provider tokens are envelope-encrypted with AES-256-GCM. Backups are encrypted before they leave the server. Storage is encrypted by the provider.
6. **Secure development.** Changes go through the merge gate and follow `change-management.md`. Security-relevant changes add a test. A red-team test suite runs at each merge.
7. **Risk review.** The founder reviews risks at least twice a year and after any incident or major change. Technical threats are in `docs/security/threat-model.md`. Risks that are accepted are written down with a reason.
8. **Monitoring.** Uptime checks, operator alerts and the activity log (`incident-response.md`).
9. **Vendors.** Anything touching customer data is reviewed first (`vendor-management.md`).
10. **Honest claims.** Public text says only what's true today. We claim no certification we don't hold. "Preparing for SOC 2" means we've written our policies and mapped our controls; it doesn't mean an audit has started.
11. **Exceptions** go in the exceptions log with a reason and an end date.
12. **Shape of the program.** The program follows the elements of the FTC Safeguards Rule (16 CFR 314), whether or not the rule applies to us. The founder is the Qualified Individual. A private record tracks each element.

## How it is checked

- Policy review every 12 months, and the quarterly access review.
- A private control matrix tracks each control as done, partial or gap.

## Gaps today

- No formal risk register. Risks are spread across the threat model, these Gaps sections and drafts.
- No independent oversight, because the company is one person.
- The policies aren't approved yet.
