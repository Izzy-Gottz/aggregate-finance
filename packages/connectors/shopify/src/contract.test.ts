// Contract checks from Shopify's public docs (shopify.dev, read 2026-10-11). See docs/qa/provider-contracts-2026-10-11.md.
import { describe, expect, it } from 'vitest'
import { classifyShopifyHttpError } from './client.ts'

describe('Shopify API contract (docs)', () => {
  it('403 means the shop is forbidden (not a reconnect); 401 means reconnect; 402/423 are the store, not us', () => {
    expect(classifyShopifyHttpError(403, { errors: 'Forbidden' })).toMatchObject({ kind: 'permanent', message: expect.stringMatching(/blocked/) })
    expect(classifyShopifyHttpError(401, { errors: '[API] Invalid API key or access token' })).toMatchObject({ kind: 'auth', message: expect.stringMatching(/Reconnect/) })
    expect(classifyShopifyHttpError(402, {}).kind).toBe('permanent')
    expect(classifyShopifyHttpError(429, {}).kind).toBe('rate_limited')
  })
})
