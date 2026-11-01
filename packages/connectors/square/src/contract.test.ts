// Contract checks from Square's public docs (developer.squareup.com, read 2026-10-11). See
// docs/qa/provider-contracts-2026-10-11.md.
import { describe, expect, it } from 'vitest'
import { classifySquareError } from './client.ts'

describe('Square API contract (docs)', () => {
  it('a 403 that is about the request is not a reconnect; missing permissions and dead tokens are', () => {
    expect(classifySquareError(403, { errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'BAD_REQUEST', detail: 'location not allowed' }] }).kind).toBe('invalid_input')
    expect(classifySquareError(403, { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'FORBIDDEN', detail: 'no' }] }).kind).toBe('auth')
    expect(classifySquareError(403, { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'INSUFFICIENT_SCOPES', detail: 'needs INVOICES_READ' }] })).toMatchObject({ kind: 'auth', message: expect.stringMatching(/Reconnect/) })
    for (const code of ['ACCESS_TOKEN_EXPIRED', 'ACCESS_TOKEN_REVOKED', 'UNAUTHORIZED']) expect(classifySquareError(401, { errors: [{ category: 'AUTHENTICATION_ERROR', code }] }).kind, code).toBe('auth')
    expect(classifySquareError(429, { errors: [{ category: 'RATE_LIMIT_ERROR', code: 'RATE_LIMITED' }] }).kind).toBe('rate_limited')
  })
})
