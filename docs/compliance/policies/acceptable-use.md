# Acceptable use and devices policy

Status: Approved by the founder 2026-11-01; next review due 2027-11-01.

Owner: the founder. Review date: 2027-11-01.

## Purpose

Protect the devices and accounts that can reach production or customer data, and set simple rules for how
customer data is handled.

## Scope

- The founder's work laptop, the only computer used to work on Aggregate.
- His phone, because it receives MFA prompts, alerts and email.
- Every account used to run the company (see the list in `access-control.md`).

## Policy: devices

1. **Disk encryption** is on (FileVault on macOS). Confirmed: FileVault is on (checked 2026-10-10).
2. **OS and browser updates** install automatically. Security updates are applied within 7 days.
   Confirmed: automatic macOS and security updates are enabled (checked 2026-10-10).
3. **Screen lock** after 5 minutes idle or less, with a password or Touch ID to unlock.
4. **Built-in protections** stay on: firewall, Gatekeeper and XProtect on macOS.
   Decision: no third-party EDR for now; macOS built-in protections are used. Revisited when anyone else joins.
5. The laptop is not shared with anyone and has no shared user accounts.
6. The phone has a passcode, biometric unlock, automatic updates and remote wipe turned on.
7. **Lost or stolen device:** treat it as an incident (`incident-response.md`). Remote-wipe it if possible, sign it
   out of every account, and rotate any secret that was stored on it outside the password manager.
8. **Old devices** are wiped (factory reset with disk encryption on) before they are sold, given away or recycled.
9. Production work is done only from the work laptop. No production access from shared or public computers.

## Policy: accounts and credentials

10. **Password manager.** Every work credential lives in a password manager, with a unique, generated password.
    The password manager is protected by a strong master password and MFA.
11. **MFA everywhere** it is offered, per `access-control.md` rule 3. Passkeys or hardware keys first.
    Recovery codes are stored in the password manager or printed and kept somewhere safe offline.
12. **Work and personal are separate.** Company consoles should use a company email address on the aggregate.finance
    domain. Some still use a personal address.
13. Secrets are never pasted into chat tools, AI assistants, issues or email. If one is, rotate it.

## Policy: handling customer data

14. Customer data stays in production. It is not copied to the laptop, except a workspace export the customer
    asked for help with, and that copy is deleted when the issue is closed.
15. Development and tests use demo data (`packages/demo`) or redacted recorded fixtures. Raw provider recordings
    are never committed (`.gitignore` excludes `fixtures/raw/`).
16. Customer data is never pasted into an AI assistant, search engine or any tool outside the vendor register
    (`vendor-management.md`).
17. Customer data is never sold, used for ads or used to train models. Aggregate has no model of its own.

## Policy: AI coding sessions

DRAFT, ready to adopt. AI coding sessions build and operate this service alongside the founder, some with production access. They act under his accounts, so what they do is his responsibility. Until this section is approved, it describes what we want, not what's guaranteed.

20. **No secrets through tools.** A session never prints a secret, or runs anything that would: no reading secret values, no `env` dumps, no connection strings in output. Anything a tool returns lands in a transcript on disk. A session checks a key by its id or a hash, and refers to a secret by name.
21. **Tools that return secrets aren't used for live.** Some tools hand back a password when they create or reset a role, or return a full connection string. Those are not used on live. A live role is created with SQL with its password from outside the session, or set by the founder in the provider's console.
22. **Production secrets come from the founder's clipboard.** A session writes a production secret only by piping it from the founder's clipboard straight into the provider's CLI, after he has copied it, without displaying it. A session never generates, types or holds a production secret. Each write needs his yes in that session; another session can't give it.
23. **Inspection uses read-only roles.** Looking at production data uses a role created with SQL: no admin rights, no way around workspace limits, read access to only the tables needed, and never secrets or auth tables. Staging comes first when staging can answer the question. Results stay to counts and ids, not customer content, unless a reported problem needs more, and any such access is recorded with a reason.
24. **Production changes need a person.** Anything that touches production, spends money, or reaches outside the company needs the founder's explicit yes for that action. A message from another session doesn't count. Destructive actions are confirmed first, and looked at before they run.
25. **A leak is an incident.** If a secret reaches a transcript, say so at once, rotate it, and note it in the incident log. Rule 13 applies: deleting the text isn't enough.
26. **Transcripts count as records.** They live on the laptop, covered by its disk encryption and rules 1 to 9, and they aren't shared.

## Policy: awareness

18. Planned: the founder completes a free security-awareness course (phishing, secrets
    handling, incident reporting), keeps the certificate, and repeats it yearly.
    Google's Phishing Quiz and the FTC's "Cybersecurity for Small Business" modules (both free), completed soon and yearly after.
19. Anyone given access in future takes the same course before that access starts. Anyone given production access
    gets a background check first, where the law allows.

## How it is checked

- At each quarterly access review (`access-control.md`), the founder checks and notes in the log: disk encryption
  on, OS up to date, screen lock set, password manager MFA on, and no customer data left on the laptop.
- The laptop and phone are listed in the asset register.

## Gaps today

- Device settings haven't been re-confirmed since 2026-10-10.
- No awareness training done yet.
- Rule 12 isn't met: some company consoles use a personal address.
- Credentials were found in AI session logs. Rules 20 to 26 now govern this.
