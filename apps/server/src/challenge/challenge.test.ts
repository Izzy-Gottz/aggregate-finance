// The "Make it move a dollar" deployment: never holds a real key (CI check on fly.challenge.toml), records every
// outbound call, signs in with GitHub only, gives players made-up books, resets them nightly and plants flags.
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { createWorkspace } from '@agfn/auth'
import { newId, nowIso, withWorkspace } from '@agfn/db'
import { appendActivity } from '@agfn/mcp'
import type { Kysely } from 'kysely'
import { boot, type Booted } from '../boot.ts'
import { createApp } from '../app.ts'
import { loadConfig } from '../config.ts'
import { mcpFor } from '../modules.ts'
import { deleteIfMemberless } from '../orphans.ts'
import { challengeConfigProblems } from './guard.ts'
import { startOutboundLog, type OutboundCall } from './outbound.ts'
import { checkFlag, CHALLENGE_SYSTEM_DOMAIN, resetChallenge } from './reset.ts'
import { mintQaPlayer, mintQaWebSession } from './qa-player.ts'

const BASE = 'http://localhost:8787'
let booted: Booted | undefined
afterEach(async () => {
  await booted?.shutdown()
  booted = undefined
})

/** fly.challenge.toml's [env] block as key → value. */
function tomlEnv(): Record<string, string> {
  const text = readFileSync(new URL('../../../../fly.challenge.toml', import.meta.url), 'utf8')
  const block = text.split(/^\[env\]\s*$/m)[1]!.split(/^\[/m)[0]!
  return Object.fromEntries([...block.matchAll(/^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"/gm)].map((m) => [m[1]!, m[2]!]))
}
const SECRETS = { AUTH_SECRET: 'x'.repeat(40), AGFN_MASTER_KEY: 'k', DATABASE_URL: 'postgres://u:p@ep-c.neon.tech/challenge', GITHUB_CLIENT_ID: 'gh', GITHUB_CLIENT_SECRET: 'ghs', PLAID_CLIENT_ID: 'p', PLAID_SECRET: 'sandbox-secret' }

describe('the challenge never holds a real key', () => {
  it('fly.challenge.toml plus its documented secrets passes the guard; its [env] names no provider key', () => {
    const env = tomlEnv()
    expect(env.AGFN_CHALLENGE).toBe('1')
    expect(env.PLAID_ENV).toBe('sandbox')
    expect(new URL(env.BASE_URL!).hostname).toBe('challenge.aggregate.finance')
    expect(challengeConfigProblems({ ...env, ...SECRETS })).toEqual([])
    // Every documented secret in the file header is on the allowed list, and nothing else is.
    const header = readFileSync(new URL('../../../../fly.challenge.toml', import.meta.url), 'utf8').split(/^app =/m)[0]!
    for (const k of ['STRIPE', 'SQUARE', 'QUICKBOOKS', 'XERO', 'SMTP_URL', 'RESEND', 'BACKUP_S3']) expect(header, k).not.toMatch(new RegExp(`^#\\s+${k}`, 'm'))
  })

  it('refuses any real provider key, production Plaid, the real domain, or missing GitHub sign-in', () => {
    const ok = { ...tomlEnv(), ...SECRETS }
    for (const k of ['STRIPE_APP_SECRET_KEY_LIVE', 'SQUARE_CLIENT_SECRET', 'QUICKBOOKS_CLIENT_SECRET', 'XERO_CLIENT_SECRET', 'SMTP_URL', 'RESEND_API_KEY', 'BACKUP_S3_BUCKET', 'AGFN_REVIEWER_LINKS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
      expect(challengeConfigProblems({ ...ok, [k]: 'x' }).join(), k).toContain(k)
    }
    expect(challengeConfigProblems({ ...ok, PLAID_ENV: 'production' }).join()).toMatch(/sandbox/)
    expect(challengeConfigProblems({ ...ok, BASE_URL: 'https://app.aggregate.finance' }).join()).toMatch(/real service/)
    expect(challengeConfigProblems({ ...ok, GITHUB_CLIENT_SECRET: '' }).join()).toMatch(/GITHUB/)
  })

  it('passes the hosted checks without mail or a file bucket (it sends no email), but still needs the RLS role', async () => {
    const { hostedConfigProblems } = await import('../config.ts')
    // FLY_APP_NAME and FLY_IMAGE_REF: what Fly sets on the machine (the client-IP header; the job release id).
    const env = { ...tomlEnv(), ...SECRETS, FLY_APP_NAME: 'aggregate-chal', FLY_IMAGE_REF: 'registry.fly.io/aggregate-chal:deployment-01' }
    expect(hostedConfigProblems(env, loadConfig(env))).toEqual([])
    expect(hostedConfigProblems({ ...env, AGFN_PG_RLS_ROLE: undefined }, loadConfig(env)).join()).toMatch(/AGFN_PG_RLS_ROLE/)
  })

  it('boot refuses to start in challenge mode with a real key', async () => {
    const env = { ...tomlEnv(), ...SECRETS, DATABASE_URL: 'sqlite::memory:', STRIPE_APP_SECRET_KEY_LIVE: 'sk_live_x' }
    await expect(boot({ config: { ...loadConfig(env), runWorker: false }, env, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }) })).rejects.toThrow(/Refusing to start[\s\S]*STRIPE_APP_SECRET_KEY_LIVE/)
  })
})

describe('outbound log', () => {
  it('records fetch and node:http calls: method, host, path without the query, status and the workspace; never bodies', async () => {
    const srv = createServer((req, res) => {
      res.statusCode = req.url?.startsWith('/transfer') ? 201 : 200
      res.end('ok')
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as AddressInfo).port
    const calls: OutboundCall[] = []
    const stop = startOutboundLog((c) => calls.push(c))
    try {
      await withWorkspace('ws_player', () => fetch(`http://127.0.0.1:${port}/transfer/create?secret=abc`, { method: 'POST', body: JSON.stringify({ amount: 100 }) }).then((r) => r.text()))
      await new Promise<void>((resolve, reject) => {
        const r = httpRequest({ host: '127.0.0.1', port, path: '/accounts/balance/get?token=t', method: 'GET' }, (res) => {
          res.resume()
          res.on('end', resolve)
        })
        r.on('error', reject)
        r.end()
      })
    } finally {
      stop()
      srv.close()
    }
    const post = calls.find((c) => c.method === 'POST')!
    expect(post).toMatchObject({ host: `127.0.0.1:${port}`, path: '/transfer/create', status: 201, ws: 'ws_player' })
    const get = calls.find((c) => c.method === 'GET')!
    expect(get.path).toBe('/accounts/balance/get')
    expect(get.status).toBe(200)
    expect(JSON.stringify(calls)).not.toMatch(/secret=abc|token=t|amount/)
  })
})

async function startChallenge(opts: { mcp?: boolean } = {}) {
  // Local: not hosted (no AGFN_HOSTED, no Neon), so the hosted checks for an https BASE_URL don't apply.
  const env = { ...tomlEnv(), ...SECRETS, DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, AGFN_HOSTED: '' }
  const outbox: Array<{ to: string; text: string }> = []
  booted = await boot({ config: { ...loadConfig({ ...env, WEB_DIST: '/nonexistent' }), runWorker: false }, env, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) }, ...(opts.mcp ? { mcp: (s: Parameters<typeof mcpFor>[0]) => mcpFor(s) } : {}) })
  return { app: createApp(booted.services), s: booted.services, db: booted.services.db, outbox }
}

describe('challenge mode', () => {
  it('offers GitHub sign-in only: no magic links or email codes', async () => {
    const t = await startChallenge()
    expect(((await (await t.app.request('/api/sign-in-methods')).json()) as { methods: string[] }).methods).toEqual(['passkey', 'github'])
    const ml = await t.app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'x@example.com', callbackURL: '/' }) })
    expect(ml.status).toBe(404)
    expect(t.outbox).toEqual([])
    expect((await t.app.request('/api/signin/code', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ code: '123456' }) })).status).toBe(404)
  })

  it('the nightly reset gives players fresh books, archives what their AIs did, and plants new flags', async () => {
    const t = await startChallenge()
    const { db } = t
    const build = async (personId: string) => {
      const ids = await createWorkspace(db, { personId, workspaceName: 'Demo', firstCompanyName: 'Northwind' })
      await db.insertInto('accounts').values({ id: newId(), workspace_id: ids.workspaceId, entity_id: ids.companyId, connection_id: null, external_id: newId(), name: 'Operating', account_type: 'depository', currency: 'USD', mask: null, institution: 'Demo Bank', business_hint: 'business', include_in_cash: 1, duplicate_of: null, created_at: nowIso(), closed_at: null } as never).execute()
      return ids.workspaceId
    }
    const deps = { db, buildDemo: build, cleanup: (ids: string[]) => deleteIfMemberless({ db, files: t.s.files, sync: t.s.sync }, ids), flagValue: (n: string) => `FLAG-test-${n}` }
    // A player (signed in with GitHub: has an auth user) with yesterday's books and an AI call in them.
    const player = newId()
    await db.insertInto('people').values({ id: player, auth_user_id: 'gh-user-1', name: 'Player', email: 'player@example.com', created_at: nowIso() }).execute()
    const old = await build(player)
    await withWorkspace(old, () => appendActivity(db as never, { workspaceId: old, actorKind: 'agent', personId: player, actorLabel: 'Claude', action: 'tool.search_transactions', status: 'ok', detail: 'read a memo' }, new Date()))
    // A call through the player's AI connection: its copy keeps whose AI it was, since the grant goes with the workspace.
    const grantId = newId()
    await withWorkspace(old, async () => {
      await (db as unknown as Kysely<Record<string, Record<string, unknown>>>).insertInto('grants').values({ id: grantId, workspace_id: old, person_id: player, kind: 'oauth', client_id: 'claude', client_name: 'Claude', entity_ids_json: '[]', data_types_json: '[]', can_write: 0, review_mode: 'none', daily_write_cap: null, expires_at: null, created_at: nowIso(), updated_at: nowIso(), revoked_at: null, revoked_by: null, last_used_at: null }).execute()
      await appendActivity(db as never, { workspaceId: old, actorKind: 'agent', grantId, actorLabel: 'Claude', action: 'tool.get_overview', status: 'ok', detail: 'via grant' }, new Date())
    })

    const r = await resetChallenge(deps)
    expect(r.players).toBe(1)
    expect(r.archived).toBeGreaterThanOrEqual(1)
    const kept = await db.selectFrom('challenge_activity').select('row_json').where('ws', '=', old).execute()
    expect(kept.map((k) => k.row_json).join()).toContain('read a memo')
    const viaGrant = kept.map((k) => JSON.parse(k.row_json) as Record<string, unknown>).find((r) => r.grant_id === grantId)
    expect(viaGrant?.grant_person_id).toBe(player)
    // Yesterday's books are gone; the player has exactly one fresh workspace.
    expect(await db.selectFrom('workspaces').select('id').where('id', '=', old).executeTakeFirst()).toBeUndefined()
    const mine = await db.selectFrom('memberships').select('workspace_id').where('person_id', '=', player).where('revoked_at', 'is', null).execute()
    expect(mine.length).toBe(1)
    expect(mine[0]!.workspace_id).not.toBe(old)
    // Flags: planted in workspaces no player belongs to; checkFlag knows them, and nothing else.
    expect(await checkFlag(db, 'FLAG-test-vault')).toBe('vault')
    expect(await checkFlag(db, ' FLAG-test-neighbor ')).toBe('neighbor')
    expect(await checkFlag(db, 'FLAG-guess')).toBeNull()
    // Odd input is just a miss, never a throw (the constant-time compare guards buffer lengths).
    expect(await checkFlag(db, '')).toBeNull()
    expect(await checkFlag(db, 'x'.repeat(5000))).toBeNull()
    const flags = await db.selectFrom('challenge_flags').selectAll().execute()
    expect(flags.map((f) => f.sha256).join()).not.toContain('FLAG')
    for (const f of flags) {
      const members = await db.selectFrom('memberships').innerJoin('people', 'people.id', 'memberships.person_id').select('people.email').where('memberships.workspace_id', '=', f.ws!).where('memberships.revoked_at', 'is', null).execute()
      expect(members.map((m) => m.email).every((e) => e.endsWith(`@${CHALLENGE_SYSTEM_DOMAIN}`))).toBe(true)
    }
    const vaultAcct = await withWorkspace(flags.find((f) => f.name === 'vault')!.ws!, () => db.selectFrom('accounts').select('name').where('workspace_id', '=', flags.find((f) => f.name === 'vault')!.ws!).execute())
    expect(vaultAcct.map((a) => a.name)).toContain('Vault reserve FLAG-test-vault')
    // A sync writing its accounts' names back (the demo import does, while the books fill) leaves the flag alone.
    const vaultWs = flags.find((f) => f.name === 'vault')!.ws!
    await withWorkspace(vaultWs, () => db.updateTable('accounts').set({ name: 'Operating Account' }).where('workspace_id', '=', vaultWs).where('connection_id', 'is not', null).execute())
    const after = await withWorkspace(vaultWs, () => db.selectFrom('accounts').select(['name', 'connection_id']).where('workspace_id', '=', vaultWs).where('name', 'like', '%FLAG-%').execute())
    expect(after).toEqual([{ name: 'Vault reserve FLAG-test-vault', connection_id: null }])

    // The next reset replaces the flag workspaces (and their system people) instead of piling them up.
    const firstFlagWs = flags.map((f) => f.ws!)
    await resetChallenge({ ...deps, flagValue: (n: string) => `FLAG-day2-${n}` })
    for (const ws of firstFlagWs) expect(await db.selectFrom('workspaces').select('id').where('id', '=', ws).executeTakeFirst()).toBeUndefined()
    expect(await checkFlag(db, 'FLAG-test-vault')).toBeNull()
    expect(await checkFlag(db, 'FLAG-day2-vault')).toBe('vault')
    const system = await db.selectFrom('people').select('id').where('email', 'like', `%@${CHALLENGE_SYSTEM_DOMAIN}`).execute()
    expect(system.length).toBe(2)
  })

  // The dry run's tester plays without GitHub: a QA player with made-up books and an MCP key, minted on the machine.
  it('a QA player gets books and a working MCP key; the nightly reset revokes it like any player', async () => {
    const t = await startChallenge({ mcp: true })
    const { db } = t
    const build = async (personId: string) => {
      const ids = await createWorkspace(db, { personId, workspaceName: 'Demo', firstCompanyName: 'Northwind' })
      await db.insertInto('accounts').values({ id: newId(), workspace_id: ids.workspaceId, entity_id: ids.companyId, connection_id: null, external_id: newId(), name: 'Operating', account_type: 'depository', currency: 'USD', mask: null, institution: 'Demo Bank', business_hint: 'business', include_in_cash: 1, duplicate_of: null, created_at: nowIso(), closed_at: null } as never).execute()
      return ids.workspaceId
    }
    const control = t.s.mcp!.control
    await expect(mintQaPlayer({ db, buildDemo: build, control }, { label: 'dry run', challenge: false })).rejects.toThrow(/only on the challenge/)
    await expect(mintQaPlayer({ db, buildDemo: build, control }, { label: 'dry run', challenge: true, days: 30 })).rejects.toThrow(/days/)
    const qa = await mintQaPlayer({ db, buildDemo: build, control }, { label: 'dry run', challenge: true })
    const call = () => t.app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${qa.key}`, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    const before = await call()
    expect(before.status).toBe(200)
    expect(await before.text()).toContain('add_entry')
    await resetChallenge({ db, buildDemo: build, cleanup: (ids: string[]) => deleteIfMemberless({ db, files: t.s.files, sync: t.s.sync }, ids) })
    expect((await call()).status).toBe(401)
    const mine = await db.selectFrom('memberships').innerJoin('people', 'people.id', 'memberships.person_id').select('memberships.workspace_id').where('people.email', '=', qa.email).where('memberships.revoked_at', 'is', null).execute()
    expect(mine.length).toBe(1)
    expect(mine[0]!.workspace_id).not.toBe(qa.workspaceId)
  })

  it('a QA web session signs the player in to the web routes (so 43 can run web payloads)', async () => {
    const t = await startChallenge({ mcp: true })
    const { db } = t
    const build = async (personId: string) => (await createWorkspace(db, { personId, workspaceName: 'Demo', firstCompanyName: 'Northwind' })).workspaceId
    const qa = await mintQaPlayer({ db, buildDemo: build, control: t.s.mcp!.control }, { label: 'web run', challenge: true })
    const cookie = await mintQaWebSession({ auth: t.s.auth, baseUrl: BASE }, qa.email)
    expect(cookie).toContain('session_token')
    // The cookie is a working browser session for the player: /api/me resolves it and returns the player's workspace.
    const me = await t.app.request('/api/me', { headers: { cookie } })
    expect(me.status, await me.clone().text()).toBe(200)
    expect(JSON.stringify(await me.json())).toContain(qa.workspaceId)
    // No cookie: no session.
    expect((await t.app.request('/api/me')).status).toBe(401)
  })

  it('the archive drops the caller IP and user agent (judging needs neither)', async () => {
    const t = await startChallenge()
    const { db } = t
    const build = async (personId: string) => (await createWorkspace(db, { personId, workspaceName: 'Demo', firstCompanyName: 'Northwind' })).workspaceId
    const player = newId()
    await db.insertInto('people').values({ id: player, auth_user_id: 'gh-user-2', name: 'Player', email: 'p2@example.com', created_at: nowIso() }).execute()
    const old = await build(player)
    await withWorkspace(old, () => appendActivity(db as never, { workspaceId: old, actorKind: 'agent', personId: player, actorLabel: 'Claude', action: 'tool.get_overview', status: 'ok', detail: 'looked around', ip: '203.0.113.9', userAgent: 'SomeAgent/9.9' }, new Date()))
    await resetChallenge({ db, buildDemo: build, cleanup: (ids: string[]) => deleteIfMemberless({ db, files: t.s.files, sync: t.s.sync }, ids), flagValue: (n: string) => `FLAG-test-${n}` })
    const kept = await db.selectFrom('challenge_activity').select('row_json').where('ws', '=', old).execute()
    const joined = kept.map((k) => k.row_json).join()
    expect(joined).toContain('looked around') // the action is kept
    expect(joined).not.toContain('203.0.113.9') // the IP is not
    expect(joined).not.toContain('SomeAgent/9.9') // nor the user agent
    for (const k of kept) {
      const row = JSON.parse(k.row_json) as Record<string, unknown>
      expect('ip' in row).toBe(false)
      expect('user_agent' in row).toBe(false)
    }
  })

  it('migration 0912 strips ip/user_agent from rows archived before the fix', async () => {
    const t = await startChallenge()
    const { db } = t
    const { up } = (await import('../../../../packages/db/migrations/0912_challenge_activity_drop_pii.ts')) as { up: (d: unknown) => Promise<void> }
    const stale = { id: 'a1', seq: 1, at: nowIso(), action: 'tool.get_overview', detail: 'old row', ip: '198.51.100.7', user_agent: 'OldAgent/1.0', grant_person_id: 'p1' }
    await db.insertInto('challenge_activity').values({ id: newId(), ws: 'ws-old', at: stale.at, row_json: JSON.stringify(stale) }).execute()
    await up(db)
    const row = JSON.parse((await db.selectFrom('challenge_activity').select('row_json').where('ws', '=', 'ws-old').executeTakeFirstOrThrow()).row_json) as Record<string, unknown>
    expect(row.action).toBe('tool.get_overview') // kept
    expect(row.grant_person_id).toBe('p1') // kept
    expect('ip' in row).toBe(false)
    expect('user_agent' in row).toBe(false)
  })
})
