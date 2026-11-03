# Aggregate security policies

Status: Approved by the founder 2026-11-01; next review due 2027-11-01.

Drafted: 2026-10-10. Owner: the founder. Next review: 2027-11-01.

## What this is

Aggregate (agfn) is open-source (AGPL-3.0) software, run by a one-person company. These short policies write down
how the founder runs security today, and what he commits to before the hosted service holds real customer data.

The rules for every policy here:

- A statement is either true today, or it is marked as a commitment with a target.
- Where a control is built in code, the file path is given. Paths are relative to the repo root.
- Decisions are recorded inline with the date they were made. Items marked "planned" are not in use yet.
- We claim no certifications. We have no SOC 2, ISO 27001 or outside audit.

These policies also fed our answers to Plaid's production security review. Technical design is in `docs/security/threat-model.md`. Vulnerability reports go through
`SECURITY.md`.

## Scope

All policies cover:

- The hosted service (app.aggregate.finance, live as an unofficial beta since 2026-11-01), its cloud accounts, database, domain and email.
- The source code and the GitHub repository.
- The founder's work laptop and the accounts he uses to run the company.

Self-hosted installs are run by their owners. Those owners hold their own keys and data. These policies do not
cover them, except where our code provides a control they inherit.

## The policies

| Policy | Covers |
|---|---|
| [information-security.md](information-security.md) | The top-level policy: roles, risk review, how the rest fit together |
| [access-control.md](access-control.md) | Who can reach production and customer data, MFA, quarterly self-review |
| [incident-response.md](incident-response.md) | Detect, triage, contain, notify (Plaid and customers), learn |
| [vendor-management.md](vendor-management.md) | Vendor register, what each vendor touches, review before adding one |
| [data-retention-and-deletion.md](data-retention-and-deletion.md) | What we keep, for how long, disconnect, workspace deletion, backups |
| [change-management.md](change-management.md) | Code review, tests, CI, dependency updates, releases, deploys |
| [acceptable-use.md](acceptable-use.md) | The founder's laptop, MFA, password manager, handling customer data |

## Status

| Item | State |
|---|---|
| Policies | Drafted 2026-10-10, reviewed 2026-11-01. Approved. |
| Approval | Approved by the founder 2026-11-01. |
| Logs these policies refer to | Not yet created. See "Records" below. |
| Hosted service | Live as an unofficial beta since 2026-11-01. Rules marked "Planned" or "Target" aren't in place yet. |

Approval record:

| Date | Version | Approved by | Notes |
|---|---|---|---|
| 2026-11-01 | First approved version | The founder | All eight policies, including AI session rules 20 to 26 in `acceptable-use.md`. Effective 2026-11-01 |
| 2026-11-02 | Operator name | The founder | Aggregate Finance LLC now operates Aggregate. No rule changed |
| 2026-11-02 | Invites | The founder | `information-security.md` rule 3 allows the customer's own invite email |

## Records

Some policies ask for a written record. Keep them in one private place, never in the public repo, because they name
accounts and vendors in detail.

- `access-review-log` (quarterly access self-review)
- `asset-register` (production services, cloud accounts, domains, laptop)
- `vendor-register` (vendors that touch customer data)
- `incident-log` (every incident and near miss)
- `exceptions-log` (any time a rule is knowingly not followed, and why)
- `restore-drill-log` (each backup restore test: date, backup name, time taken, problems). Procedure: `docs/self-hosting.md` § Restore drill

Records are kept privately, in the private source repository, and left out of the public one.

## Review cadence

1. The founder reviews every policy at least every 12 months. The next review is 2027-11-01.
2. He also reviews a policy when something it covers changes: a new hire or contractor, a new vendor that touches
   customer data, a new hosting setup, or an incident.
3. Each review updates the "Review date" line in the policy and adds a row to the approval record above.
4. If a policy no longer matches what is done, either the practice or the policy changes the same week. A policy
   that describes something we don't do is worse than no policy.

## When the company grows

These policies are written for one person. When anyone else gets access to production, code merge rights or
customer data, the founder rewrites the affected policies before that access is granted. That includes contractors.
