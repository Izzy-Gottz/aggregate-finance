// Raw payload capture. Every provider object a connector normalizes is stored first, and the event carries
// its rawRef so a mapping bug can be fixed later without re-pulling. The sync worker backs this with
// raw_records; tests use MemoryRawSink.

import { createHash } from 'node:crypto'
import type { ConnectionId, Id, RawSink } from '@agfn/contracts'

export type { RawSink }

/** Deterministic id: re-syncing an unchanged object yields the same ref (idempotent storage). */
export function rawId(connectionId: string, kind: string, externalId: string, payload: unknown): Id {
  const h = createHash('sha256')
  h.update(connectionId).update('\0').update(kind).update('\0').update(externalId).update('\0')
  h.update(stableStringify(payload))
  return 'raw_' + h.digest('hex').slice(0, 32)
}

export interface StoredRaw {
  id: Id
  connectionId: ConnectionId
  kind: string
  externalId: string
  payload: unknown
}

export class MemoryRawSink implements RawSink {
  readonly records = new Map<Id, StoredRaw>()

  async put(connectionId: ConnectionId, kind: string, externalId: string, payload: unknown): Promise<Id> {
    const id = rawId(connectionId, kind, externalId, payload)
    if (!this.records.has(id)) this.records.set(id, { id, connectionId, kind, externalId, payload })
    return id
  }
}

/** Sink that stores nothing (connect-time probes, health checks). */
export const nullRawSink: RawSink = {
  put: async (connectionId, kind, externalId, payload) => rawId(connectionId, kind, externalId, payload),
}

/** JSON with sorted keys, so hashing doesn't depend on provider key order. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (value instanceof Uint8Array) return JSON.stringify(Buffer.from(value).toString('base64'))
  const obj = value as Record<string, unknown>
  return (
    '{' +
    Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  )
}
