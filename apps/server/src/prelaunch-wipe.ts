// The launch-day wipe (MASTER S9, Yisrael's decision 2026-10-11): delete the test data from before launch but keep
// what app-directory reviewers use, so open reviews don't break.
//
// Kept: every person with a live reviewer link (not revoked, not expired), every person whose email is on the
// keep-list, and every workspace those people belong to (with its connections, grants and books). Everything else goes,
// through the same paths the app uses: deleteWorkspace (provider access revoked first, files, rows) and deleteAccount
// (AI access, sign-in records, identity emptied). Then sign-in leftovers nobody kept points at: unused auth users,
// pending magic links, and dead reviewer links.
//
// planWipe only reads. Run it first (agfn prelaunch-wipe), read the list, then --apply. Run it on a Neon branch copy
// before main, with a fresh backup taken first.

import type { Kysely } from 'kysely'
import { withBypass, withWorkspace, type CoreTables } from '@agfn/db'
import { isPoolPerson } from '@agfn/demo'
import { deleteAccount, type DeleteAccountDeps } from './delete-account.ts'
import { deleteWorkspace } from './delete-workspace.ts'
import { GLASS_EMAIL } from './glass-ledger.ts'

export interface WipePlan {
  keepPeople: Array<{ id: string; email: string; why: string }>
  keepWorkspaces: Array<{ id: string; name: string; why: string }>
  deleteWorkspaces: Array<{ id: string; name: string }>
  deletePeople: Array<{ id: string; email: string }>
  /** Auth users no kept person points at (includes those of the people above). */
  deleteAuthUsers: number
  pendingMagicLinks: number
  deadReviewerLinks: number
  /** Keep-list emails with no account (only with allowMissing: champions who never signed up). */
  notFound: string[]
}

type AnyDb = Kysely<Record<string, Record<string, unknown>>>

/**
 * Connector key → name, for providers whose reviewer signs up with an email we don't know (see planWipe). Shopify was
 * approved 2026-10-22 but stays: merchants can now install from the App Store before the wipe, and their installs must survive it. Add Stripe here if its reviewer signs up instead of using their reviewer link / keep-list entry.
 */
export const REVIEW_PENDING_INSTALLS: Readonly<Record<string, string>> = { shopify: 'Shopify', deel: 'Deel' }

export async function planWipe(db: Kysely<CoreTables>, opts: { keepEmails?: string[]; allowMissing?: boolean; now?: Date } = {}): Promise<WipePlan> {
  return withBypass('wipe:plan', async () => {
    const now = (opts.now ?? new Date()).toISOString()
    const keepEmails = new Set((opts.keepEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))
    const people = await db.selectFrom('people').select(['id', 'email', 'auth_user_id']).execute()
    const live = await db.selectFrom('reviewer_links').select(['person_id', 'label']).where('revoked_at', 'is', null).where('expires_at', '>', now).execute()
    const liveBy = new Map(live.map((l) => [l.person_id, l.label]))
    // The public demo's system people (public-demo.ts): current and still-retiring books stay; it's rebuilt nightly anyway.
    const demo = await db.selectFrom('public_demo').select(['person_id', 'retiring_person']).execute()
    const demoIds = new Set(demo.flatMap((d) => [d.person_id, d.retiring_person]).filter((x): x is string => !!x))
    // Providers whose app reviewer signs up on live with their own email (Shopify: installing needs it to match the
    // store's staff email; Deel: the App Store review was told open signup + magic link), so neither a reviewer link
    // nor the keep-list can name them: whoever owns or runs a workspace with a live connection to one stays.
    const installIds = new Map<string, string>()
    const installWs = await db.selectFrom('connections').select(['workspace_id', 'connector_key']).where('connector_key', 'in', Object.keys(REVIEW_PENDING_INSTALLS)).where('status', '!=', 'disconnected').orderBy('created_at').execute()
    if (installWs.length) {
      const managers = await db.selectFrom('memberships').select(['person_id', 'workspace_id']).where('workspace_id', 'in', [...new Set(installWs.map((c) => c.workspace_id))]).where('role', 'in', ['owner', 'admin']).where('revoked_at', 'is', null).execute()
      for (const c of installWs) for (const m of managers) if (m.workspace_id === c.workspace_id && !installIds.has(m.person_id)) installIds.set(m.person_id, `a ${REVIEW_PENDING_INSTALLS[c.connector_key]} install`)
    }

    const keepPeople: WipePlan['keepPeople'] = []
    const deletePeople: WipePlan['deletePeople'] = []
    for (const p of people) {
      if (liveBy.has(p.id)) keepPeople.push({ id: p.id, email: p.email, why: `reviewer link "${liveBy.get(p.id)}"` })
      else if (demoIds.has(p.id)) keepPeople.push({ id: p.id, email: p.email, why: 'the public demo' })
      // Demos filled ahead of time for "Look around" (packages/demo pool.ts): nobody's, so not users; kept, not wiped.
      else if (isPoolPerson(p.email)) keepPeople.push({ id: p.id, email: p.email, why: 'the demo pool' })
      // The Glass Ledger (glass-ledger.ts, launch step 5a): Aggregate's own public books, kept if it already exists.
      else if (p.email === GLASS_EMAIL) keepPeople.push({ id: p.id, email: p.email, why: 'the Glass Ledger' })
      else if (keepEmails.has(p.email.toLowerCase())) keepPeople.push({ id: p.id, email: p.email, why: 'on the keep-list' })
      else if (installIds.has(p.id)) keepPeople.push({ id: p.id, email: p.email, why: installIds.get(p.id)! })
      // Already deleted accounts have nothing left to remove.
      else if (!p.email.endsWith('@invalid') || p.auth_user_id) deletePeople.push({ id: p.id, email: p.email })
    }
    const missing = [...keepEmails].filter((e) => !people.some((p) => p.email.toLowerCase() === e))
    if (missing.length && !opts.allowMissing) throw new Error(`not found, so not kept: ${missing.join(', ')} (check the spelling)`)

    const keptIds = new Set(keepPeople.map((p) => p.id))
    const memberships = await db.selectFrom('memberships').select(['workspace_id', 'person_id']).where('revoked_at', 'is', null).execute()
    const workspaces = await db.selectFrom('workspaces').select(['id', 'name']).execute()
    const keepWorkspaces: WipePlan['keepWorkspaces'] = []
    const deleteWorkspaces: WipePlan['deleteWorkspaces'] = []
    for (const w of workspaces) {
      const keptMember = keepPeople.find((p) => memberships.some((m) => m.workspace_id === w.id && m.person_id === p.id))
      if (keptMember) keepWorkspaces.push({ id: w.id, name: w.name, why: `member ${keptMember.email}` })
      else deleteWorkspaces.push({ id: w.id, name: w.name })
    }

    const anyDb = db as unknown as AnyDb
    const keptAuth = people.filter((p) => keptIds.has(p.id) && p.auth_user_id).map((p) => p.auth_user_id as string)
    const authUsers = (await anyDb.selectFrom('auth_user').select('id').execute().catch(() => [])) as Array<{ id: string }>
    const pending = (await anyDb.selectFrom('auth_verification').select('id').execute().catch(() => [])) as unknown[]
    const dead = await db.selectFrom('reviewer_links').select('id').where((eb) => eb.or([eb('revoked_at', 'is not', null), eb('expires_at', '<=', now)])).execute()
    return {
      keepPeople,
      keepWorkspaces,
      deleteWorkspaces,
      deletePeople,
      deleteAuthUsers: authUsers.filter((u) => !keptAuth.includes(u.id)).length,
      pendingMagicLinks: pending.length,
      deadReviewerLinks: dead.length,
      notFound: missing,
    }
  })
}

export interface WipeResult {
  workspacesDeleted: number
  peopleDeleted: number
  authUsersDeleted: number
  failures: string[]
}

/**
 * For a run on a Neon branch copy (agfn prelaunch-wipe --branch-copy): the copy shares live's provider tokens and file
 * bucket, so deps whose provider disconnect and file delete do nothing; only the copy's rows change.
 */
export function rowsOnly<D extends Pick<DeleteAccountDeps, 'files' | 'sync'>>(deps: D): D {
  const files = new Proxy(deps.files, { get: (t, k) => (k === 'delete' ? async () => undefined : Reflect.get(t, k, t)) })
  const sync = new Proxy(deps.sync, { get: (t, k) => (k === 'disconnect' ? async () => ({ revoked: false }) : Reflect.get(t, k, t)) })
  return { ...deps, files, sync }
}

/** Carries out a plan from planWipe. One workspace or person that fails doesn't stop the rest; failures are listed. */
export async function applyWipe(deps: DeleteAccountDeps, plan: WipePlan): Promise<WipeResult> {
  const { db } = deps
  const anyDb = db as unknown as AnyDb
  const failures: string[] = []
  const msg = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300)

  // 1. Workspaces first (provider access revoked inside), so accounts below are never sole owners of one.
  let workspacesDeleted = 0
  for (const w of plan.deleteWorkspaces) {
    try {
      await withWorkspace(w.id, () => deleteWorkspace(deps, w.id))
      workspacesDeleted++
    } catch (err) {
      failures.push(`workspace ${w.id} (${w.name}): ${msg(err)}`)
    }
  }

  return withBypass('wipe:apply', async () => {
    // 2. Accounts: AI access, memberships left in kept workspaces, sign-in records; then the emptied row itself when
    // nothing points at it any more.
    let peopleDeleted = 0
    for (const p of plan.deletePeople) {
      try {
        await deleteAccount(deps, p.id)
        await db.deleteFrom('reviewer_links').where('person_id', '=', p.id).execute()
        await db.deleteFrom('people').where('id', '=', p.id).execute().catch(() => undefined) // kept (emptied) if history in a kept workspace refers to it
        peopleDeleted++
      } catch (err) {
        failures.push(`person ${p.id} (${p.email}): ${msg(err)}`)
      }
    }

    // 3. Sign-in leftovers: auth users no kept person uses, pending magic links, dead reviewer links.
    const keptAuth = (await db.selectFrom('people').select('auth_user_id').where('id', 'in', plan.keepPeople.length ? plan.keepPeople.map((p) => p.id) : ['-']).execute()).map((r) => r.auth_user_id).filter((x): x is string => Boolean(x))
    const authUsers = (await anyDb.selectFrom('auth_user').select('id').execute().catch(() => [])) as Array<{ id: string }>
    let authUsersDeleted = 0
    for (const u of authUsers) {
      if (keptAuth.includes(u.id)) continue
      for (const t of ['auth_session', 'auth_account', 'passkey', 'oauthAccessToken', 'oauthRefreshToken', 'oauthConsent']) {
        await anyDb.deleteFrom(t).where('userId', '=', u.id).execute().catch(() => undefined)
      }
      try {
        await anyDb.deleteFrom('auth_user').where('id', '=', u.id).execute()
        authUsersDeleted++
      } catch (err) {
        failures.push(`auth user ${u.id}: ${msg(err)}`)
      }
    }
    await anyDb.deleteFrom('auth_verification').execute().catch(() => undefined)
    await db.deleteFrom('reviewer_links').where((eb) => eb.or([eb('revoked_at', 'is not', null), eb('expires_at', '<=', new Date().toISOString())])).execute()
    return { workspacesDeleted, peopleDeleted, authUsersDeleted, failures }
  })
}
