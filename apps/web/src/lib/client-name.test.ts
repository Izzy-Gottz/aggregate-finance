import { describe, expect, it } from 'vitest'
import { shownClientName } from './client-name.ts'

describe('shownClientName', () => {
  it('adds the host for a metadata-document client, once', () => {
    expect(shownClientName('https://client.example/oauth/client.json', 'Example AI')).toBe('Example AI (client.example)')
    expect(shownClientName('https://Smithery.ai/c.json', 'Claude')).toBe('Claude (smithery.ai)')
    expect(shownClientName('https://client.example/c.json', 'client.example agent')).toBe('client.example agent')
    expect(shownClientName('https://client.example/c.json', undefined)).toBe('Your AI (client.example)')
  })
  it('leaves registered clients as they are', () => {
    expect(shownClientName('Xk2v9q', 'Claude')).toBe('Claude')
    expect(shownClientName('Xk2v9q', '  ')).toBe('Your AI')
  })
})
