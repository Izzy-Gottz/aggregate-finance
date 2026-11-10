# Change management policy

Status: Approved by the founder 2026-11-01; next review due 2027-11-01.

Owner: the founder. Review date: 2027-11-01.

## Purpose

Make sure every change to code, dependencies or production is tested, traceable and reversible.

## Scope

Application code, database migrations, dependencies, the Docker image, CI configuration and production
configuration (secrets, environment, hosting settings).

## Policy

1. **All code goes through git.** Every change is a commit with a message saying what changed and why.
2. **The merge gate.** Every change reaches `main` through `scripts/merge-to-main.sh`. It merges the latest `main`
   into the branch, scans the branch's commits with gitleaks, does a fresh install, runs `npm run typecheck` and the full
   `vitest` suite, and stops on any failure. Docs-only changes skip install and tests. Only then is the branch merged and pushed to the private GitHub repo.
3. **CI.** `.github/workflows/ci.yml` runs on pull requests and on demand. Its jobs: typecheck, tests and web build;
   `npm audit` on shipped dependencies; a Trivy scan of the built Docker image; migrations against a real Postgres 17;
   and gitleaks secret scanning across full history. It does
   not run on every push to `main` today, to save CI minutes; the merge gate in rule 2 runs the same tests locally.
   Planned: CI runs on every push to `main`, and a deploy only happens from a commit whose
   CI checks passed.
4. **Tests that matter for security** are part of the suite and must pass:
   - Permission tests that try to cross companies and reach Personal spaces (`packages/auth/src/permissions.test.ts`).
   - Injection red-team tests: an injected document must never cause an outbound effect
     (`packages/mcp/src/redteam.test.ts`).
   - Envelope encryption and key rotation (`packages/security/src/envelope.test.ts`).
   - Disconnect revokes and wipes (`packages/sync/src/disconnect.test.ts`).
   - Connector contract tests on redacted recorded fixtures, e.g. `packages/connectors/plaid/src/plaid.recorded.test.ts`.
5. **Code review.** The founder is the only engineer. There is no second human reviewer today, and AI-assisted
   review does not count as one. To make up for it:
   - The founder reads the full diff of any change to `packages/security`, `packages/auth`,
     `packages/connectors/*`, `packages/mcp` or `apps/server/src/security.ts` before merging.
   - A security-relevant change must add or update a test.

   - **Security impact is recorded per change.** A security-relevant change states its security impact in one line in
     the commit or merge message — what it changes about our security posture and why it is safe. Other changes need
     none. Git history is the change record; this line is the change's security note (SOC 2 CC3.4, CC8.1).

   When a second engineer or contractor joins, every merge to `main` needs their approval in a pull request.
   Decision: no paid outside reviewer soon; automated red-team tests run on every merge (`apps/server/src/redteam`). Revisited when revenue allows.
6. **Branch protection.** Planned: turn on GitHub branch protection for `main`, with the CI
   checks required and force-push blocked.
7. **Database changes** are versioned Kysely migrations in `packages/db/migrations/`. They run on start and are
   tested on SQLite and Postgres. Migrations never cascade-delete money data. A migration that deletes or rewrites
   customer data needs a backup taken just before it is deployed.
8. **Secrets never enter the repo.** `.gitignore` excludes `.env*`, `data/` and `fixtures/raw/`. Test fixtures are
   redacted. gitleaks runs in CI. If a secret is committed anyway, rotate it; rewriting history is not enough.
   Follow `incident-response.md`.
9. **Dependencies.**
   - True today: `package-lock.json` pins every version, and installs use `npm ci`.
   - Dependabot security updates are configured on the public repo (`.github/dependabot.yml`).
   - Both the merge gate and CI fail on high or critical advisories in shipped dependencies (`npm audit --omit=dev`).
     CodeQL and OpenSSF Scorecard run weekly on the public repo.
   - The production Docker image is scanned for OS and library vulnerabilities by Trivy in CI (the `image-scan` job,
     2026-11-03). It fails on fixable high/critical findings; base-image CVEs with no fix available don't block.
   - Target patch times: critical within 7 days, high within 30 days, others at the next routine update. Confirmed.
   - New dependencies are added only when needed. Before adding one, check it is maintained and widely used.
10. **Build.** One Dockerfile builds one image for self-host and hosted (`Dockerfile`). The runtime image is
    Alpine, drops dev dependencies and runs as the non-root `node` user.
11. **Deploys.** `scripts/deploy.sh` deploys to staging, then QA checks it, then the same commit goes live. Fly's blue-green strategy starts the new machine and moves traffic only after `/healthz` passes.
    Planned:
    - Deploys go out only from `main`, only from a commit that passed CI.
    - Each deploy is recorded (date, commit) in the host's deploy history.
    - The previous image is kept, so a bad deploy can be rolled back in minutes.
    Host: Fly.io. Fly keeps previous releases for rollback.
12. **Releases.** Target, before the first public release: tagged releases with release notes, and signed tags or
    image provenance (our plan promises signed releases; not done yet). Decision: signed git tags, and container images signed with Sigstore cosign (keyless, from GitHub Actions).
13. **Production config changes** (secrets, environment, scaling, network) are made only by the founder, in the
    host's console or CLI, and noted in the asset register when they change what runs.
14. **Emergency changes** may skip rule 3's wait for CI only to stop active harm. Tests still run before or right
    after, and the reason goes in the incident log.

## How it is checked

- `git log` on `main` shows every merge came through the merge gate ("Merge <branch>" commits).
- At each quarterly access review (`access-control.md`), the founder also checks: branch protection on, Dependabot
  alerts reviewed, no open critical alerts past the patch time.

## Gaps today

- Branch protection can't be turned on for the private source repo on GitHub's free plan. The merge gate is a local script, so it depends on being used.
- CI runs on pull requests and on demand, not on every push to `main`. Deploys aren't tied to a passed CI run.
- No signed releases.
- No second human reviewer. AI review is used but isn't independent review.
- gitleaks only runs in the merge gate where gitleaks is installed; otherwise it warns.
