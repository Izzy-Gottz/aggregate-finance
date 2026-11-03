# Business continuity policy

Status: Approved by the founder 2026-11-01; next review due 2027-11-01.

Owner: the founder. Review date: 2027-11-01.

## Purpose

Say how the service keeps running, or comes back, after an outage, data loss, or the loss of a vendor or the founder.

## What protects the service today

| Risk | What we have |
|---|---|
| A bad deploy | Blue-green deploys: traffic moves only after `/healthz` passes. Earlier releases stay available at Fly |
| A machine fails | Fly restarts it. One always-on machine in Ashburn, Virginia |
| Data lost or damaged | Neon point-in-time history, 7 days. Nightly encrypted backups to a separate Cloudflare R2 bucket, kept 25 days |
| Master key lost | Provider tokens and every backup become unreadable. Customers would have to reconnect. A copy held off Fly is planned, and is step 0 of the KMS plan |
| A region outage | No failover. The app and database are both in the US East region, so we wait for the provider |
| A vendor is lost | Self-hosting works, and the code is public, but no prepared migration exists |
| The founder is unavailable | No backup person. Customers can still export only while the service runs |

## Targets

These are aims, not promises, and they haven't been tested: restore within 1 day, losing at most 1 day of data. No uptime commitment is made to customers.

## Policy

1. Nightly backups run, and a failure raises an operator alert.
2. A restore drill runs once a year and after any key change (`docs/security/backup-restore.md`), and goes in the restore-drill log.
3. Before a risky database change, take a Neon snapshot or a fresh backup.
4. An outage that lasts over an hour gets a plain note to affected customers.
5. Any restore of production data needs the founder's decision. A restore branch must never replace main without one.

## How it is checked

- The restore-drill log, and a yearly walk-through of this page.

## Gaps today

- One hosted restore drill is recorded, passed 2026-10-11 (`docs/security/backup-restore.md`). No wider continuity exercise yet.
- No copy of the master key held off Fly is confirmed.
- No failover or second region.
- No backup person. Passwords and the ability to run the service die with one person's access.
