# Acceptable use and devices policy

Status: DRAFT, pending founder approval.

Owner: the founder. Review date: 2027-04-10.

## Purpose

Protect the devices and accounts that can reach production or customer data, and set simple rules for how
customer data is handled.

## Scope

- The founder's work laptop. Confirmed: one Apple MacBook Air (13-inch, M3, model Mac15,12) is the only computer used to work on Aggregate.
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
    Apple Passwords (iCloud Keychain), protected by the Apple Account password and two-factor authentication.
11. **MFA everywhere** it is offered, per `access-control.md` rule 3. Passkeys or hardware keys first.
    Recovery codes are stored in the password manager or printed and kept somewhere safe offline.
12. **Work and personal are separate.** Company consoles use a company email address on the aggregate.finance
    domain, not a personal one. Company addresses on aggregate.finance are being set up (October 2026); every company console moves to them before hosted launch.
13. Secrets are never pasted into chat tools, AI assistants, issues or email. If one is, rotate it.

## Policy: handling customer data

14. Customer data stays in production. It is not copied to the laptop, except a workspace export the customer
    asked for help with, and that copy is deleted when the issue is closed.
15. Development and tests use demo data (`packages/demo`) or redacted recorded fixtures. Raw provider recordings
    are never committed (`.gitignore` excludes `fixtures/raw/`).
16. Customer data is never pasted into an AI assistant, search engine or any tool outside the vendor register
    (`vendor-management.md`).
17. Customer data is never sold, used for ads or used to train models. Aggregate has no model of its own.

## Policy: awareness

18. Target, before hosted launch: the founder completes a free security-awareness course (phishing, secrets
    handling, incident reporting), keeps the certificate, and repeats it yearly.
    Google's Phishing Quiz and the FTC's "Cybersecurity for Small Business" modules (both free), completed before hosted launch and yearly after.
19. Anyone given access in future takes the same course before that access starts. Anyone given production access
    gets a background check first, where the law allows.

## How it is checked

- At each quarterly access review (`access-control.md`), the founder checks and notes in the log: disk encryption
  on, OS up to date, screen lock set, password manager MFA on, and no customer data left on the laptop.
- The laptop and phone are listed in the asset register.

## Gaps today

- Device settings above have not been confirmed and recorded.
- No awareness training done yet.
