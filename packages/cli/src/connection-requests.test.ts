/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot } from '@agfn/server/boot'
import { loadConfig } from '@agfn/server/config'
import type { Io } from './io.ts'
import { connectionRequestsCommand } from './connection-requests.ts'

function io(env: Record<string, string> = {}): Io & { lines: string[] } {
  const lines: string[] = []
  return { cwd: process.cwd(), env, out: (s: string) => void lines.push(s), err: () => {}, lines } as unknown as Io & { lines: string[] }
}

const bootWith = (asks: Array<[string, string]>) => async () => {
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: 'http://localhost:8787', WEB_DIST: '/nonexistent' }), runWorker: false }
  const b = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => {} } })
  const at = new Date().toISOString()
  const db = b.handle.db as any
  for (const id of new Set(asks.map((a) => a[0]))) await db.insertInto('workspaces').values({ id, name: id, base_currency: 'USD', created_at: at }).execute()
  for (const [ws, app] of asks) await db.insertInto('connection_requests').values({ workspace_id: ws, app_key: app, created_at: at }).execute()
  return b
}

describe('agfn connection-requests', () => {
  it('prints each app and how many workspaces asked, most first; JSON too', async () => {
    const asks: Array<[string, string]> = [['w1', 'hospitable'], ['w2', 'hospitable'], ['w2', 'harvest'], ['w3', 'hospitable']]
    const t = io()
    expect(await connectionRequestsCommand([], t, bootWith(asks))).toBe(0)
    expect(t.lines).toEqual(['Hospitable  3 workspaces', 'Harvest     1 workspace'])
    const j = io()
    expect(await connectionRequestsCommand(['--json'], j, bootWith(asks))).toBe(0)
    expect(JSON.parse(j.lines.join('\n'))).toEqual([{ app: 'hospitable', name: 'Hospitable', workspaces: 3 }, { app: 'harvest', name: 'Harvest', workspaces: 1 }])
  })

  it('says so when nobody has asked, and rejects bad options', async () => {
    const t = io()
    expect(await connectionRequestsCommand([], t, bootWith([]))).toBe(0)
    expect(t.lines).toEqual(['no connection requests yet'])
    await expect(connectionRequestsCommand(['--frobnicate'], io(), bootWith([]))).rejects.toThrow()
  })

  it('hosted: needs an operator name and a reason before it boots', async () => {
    const never = async () => { throw new Error('booted') }
    await expect(connectionRequestsCommand([], io({ AGFN_HOSTED: '1', AGFN_OPERATOR: 'ship' }), never as never)).rejects.toThrow(/--reason/)
  })
})
