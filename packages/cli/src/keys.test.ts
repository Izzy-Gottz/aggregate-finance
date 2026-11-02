import { describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing, seal, sealedKeyId, unseal, type KeyRing } from '@agfn/security'
import { SECRET_PURPOSE } from '@agfn/sync'
import { boot } from '@agfn/server/boot'
import { loadConfig } from '@agfn/server/config'
import type { Kysely } from 'kysely'
import type { Io } from './io.ts'
import { keysCommand } from './keys.ts'

function io(env: Record<string, string> = {}): Io & { lines: string[] } {
  const lines: string[] = []
  return { cwd: process.cwd(), env, out: (s: string) => void lines.push(s), err: () => undefined, lines } as unknown as Io & { lines: string[] }
}

const ctx = (id: string) => ({ workspaceId: 'w1', recordId: id, purpose: SECRET_PURPOSE })
const SHOP = { workspaceId: 'shopify-pending', recordId: 'a.myshopify.com', purpose: 'shopify_pending_install' }

/** Rows sealed with an old key, on a server whose current key is new. One database across runs; closing is left to the test. */
async function world(extraRow?: (old: KeyRing) => string) {
  const oldKey = generateMasterKey()
  const old = loadKeyRing({ AGFN_MASTER_KEY: oldKey })
  const keys = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey(), AGFN_OLD_MASTER_KEYS: oldKey })
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: 'http://localhost:8787', WEB_DIST: '/nonexistent' }), runWorker: false }
  const b = await boot({ config, keys, mailer: { send: async () => {} } })
  const at = new Date().toISOString()
  const db = b.handle.db as unknown as Kysely<any>
  await db.insertInto('workspaces').values({ id: 'w1', name: 'Acme', base_currency: 'USD', created_at: at }).execute()
  const conn = (id: string, secret_enc: string | null) => db.insertInto('connections').values({ id, workspace_id: 'w1', connector_key: 'plaid', entity_id: null, display_name: id, status: 'active', secret_enc, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: at }).execute()
  await conn('c1', seal(old, { token: 'one' }, ctx('c1')))
  await conn('c2', seal(keys, { token: 'two' }, ctx('c2')))
  await conn('c3', null)
  if (extraRow) await conn('c4', extraRow(old))
  await db.insertInto('shopify_pending_installs').values({ shop: SHOP.recordId, secret_enc: seal(old, { token: 'shop' }, SHOP), created_at: at, link_hash: null, link_expires_at: null, link_email: null }).execute()
  const shutdown = b.shutdown
  b.shutdown = async () => undefined
  const secrets = async () => Object.fromEntries((await db.selectFrom('connections').select(['id', 'secret_enc']).execute()).map((r) => [r.id, r.secret_enc]))
  const shop = async () => (await db.selectFrom('shopify_pending_installs').select('secret_enc').executeTakeFirstOrThrow()).secret_enc
  return { keys, old, run: (argv: string[], t = io()) => keysCommand(argv, t, async () => b), secrets, shop, close: shutdown, db }
}

describe('agfn keys reseal', () => {
  it('counts by key and changes nothing by default', async () => {
    const w = await world()
    try {
      const before = await w.secrets()
      const t = io()
      expect(await w.run(['reseal'], t)).toBe(0)
      const out = t.lines.join('\n')
      expect(out).toContain(`${w.old.current.id}: 2 row(s) to move`)
      expect(out).toContain(`${w.keys.current.id}: 1 row(s)`)
      expect(out).toContain('Dry run')
      expect(await w.secrets()).toEqual(before)
    } finally {
      await w.close()
    }
  })

  it('moves every secret to the current key, still decrypts, leaves empty rows, and a second run has nothing to do', async () => {
    const w = await world()
    try {
      const t = io()
      expect(await w.run(['reseal', '--apply', '--confirm', 'RESEAL'], t)).toBe(0)
      expect(t.lines.join('\n')).toContain('moved 2, changed by a sync meanwhile 0, failed 0')
      expect(JSON.stringify(t.lines)).not.toMatch(/one|v1\./)
      const after = await w.secrets()
      expect(sealedKeyId(after.c1 as string)).toBe(w.keys.current.id)
      expect(unseal(w.keys, after.c1 as string, ctx('c1'))).toEqual({ token: 'one' })
      expect(unseal(w.keys, after.c2 as string, ctx('c2'))).toEqual({ token: 'two' })
      expect(after.c3).toBeNull()
      expect(unseal(w.keys, await w.shop(), SHOP)).toEqual({ token: 'shop' })

      const again = io()
      expect(await w.run(['reseal', '--apply', '--confirm', 'RESEAL'], again)).toBe(0)
      expect(again.lines.join('\n')).toContain('moved 0')
      expect(await w.secrets()).toEqual(after)
    } finally {
      await w.close()
    }
  })

  it('a row that fails stays as it was, the rest still move, and the run says so', async () => {
    const w = await world((old) => seal(old, { token: 'bound elsewhere' }, ctx('some-other-record')))
    try {
      const bad = (await w.secrets()).c4
      const t = io()
      expect(await w.run(['reseal', '--apply', '--confirm', 'RESEAL'], t)).toBe(1)
      expect(t.lines.join('\n')).toContain('moved 2, changed by a sync meanwhile 0, failed 1')
      const after = await w.secrets()
      expect(after.c4).toBe(bad)
      expect(sealedKeyId(after.c1 as string)).toBe(w.keys.current.id)
    } finally {
      await w.close()
    }
  })

  it('needs the confirm word, and on hosted a name and reason, before it boots', async () => {
    const never = (async () => { throw new Error('booted') }) as never
    await expect(keysCommand(['reseal', '--apply'], io(), never)).rejects.toThrow(/--confirm RESEAL/)
    await expect(keysCommand(['nope'], io(), never)).rejects.toThrow(/usage/)
    await expect(keysCommand(['reseal'], io({ AGFN_HOSTED: '1', AGFN_OPERATOR: 'x' }), never)).rejects.toThrow(/--reason/)
  })

  it('records the run in the operator log on hosted', async () => {
    const w = await world()
    try {
      expect(await w.run(['reseal', '--reason', 'rotation test'], io({ AGFN_HOSTED: '1', AGFN_OPERATOR: 'dc' }))).toBe(0)
      expect(await w.db.selectFrom('operator_access').selectAll().execute()).toMatchObject([{ operator: 'dc', command: 'keys reseal' }])
    } finally {
      await w.close()
    }
  })
})
