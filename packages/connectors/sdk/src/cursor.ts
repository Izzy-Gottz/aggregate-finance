// Opaque cursors: versioned JSON, base64url-encoded. Connectors keep whatever state they need
// (provider cursor, page token, high-water timestamp, phase of a multi-resource sync) inside.

import { ConnectorError } from './errors.ts'

export interface CursorCodec<S> {
  encode(state: S): string
  /** null/empty → null (full backfill). A malformed or wrong-version cursor throws cursor_invalid. */
  decode(cursor: string | null): S | null
}

/**
 * `version` doubles as the connector's mapping version: bump it when the mapping changes, and every existing
 * connection's cursor turns invalid, so runSync re-reads from the start once (new entity types and changed mappings
 * reach old data too).
 */
export function cursorCodec<S>(provider: string, version = 1, validate?: (v: unknown) => v is S): CursorCodec<S> {
  return {
    encode(state) {
      return Buffer.from(JSON.stringify({ v: version, s: state }), 'utf8').toString('base64url')
    },
    decode(cursor) {
      if (!cursor) return null
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
      } catch (e) {
        throw new ConnectorError('cursor_invalid', 'cursor is not readable', { provider, cause: e })
      }
      const p = parsed as { v?: unknown; s?: unknown } | null
      if (!p || typeof p !== 'object' || p.v !== version || !('s' in p)) {
        throw new ConnectorError('cursor_invalid', 'cursor version mismatch', { provider })
      }
      if (validate && !validate(p.s)) throw new ConnectorError('cursor_invalid', 'cursor shape mismatch', { provider })
      return p.s as S
    },
  }
}
