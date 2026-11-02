# MCP security conformance

A self-assessment of Aggregate's hosted server, https://app.aggregate.finance/mcp. Nobody has certified this; no MCP
certification exists. Checked on 2026-11-01 against the code on `main` and the live endpoints.

The spec pages used are version 2025-11-25 of [Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
and the current [Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices).

**Met** means our code or live behavior shows it. **Tested** means Better Auth's OAuth provider does it and our own test
proves it. **Gap** means we don't do it. **N/A** means it applies to something we aren't.

## Server and resource

| Requirement | Status | Evidence |
|---|---|---|
| Publish Protected Resource Metadata with `authorization_servers` | Met | `/.well-known/oauth-protected-resource/mcp`; [`packages/mcp/src/http.ts`](../../packages/mcp/src/http.ts) |
| Point to it from `WWW-Authenticate` on a 401 | Met | [`http.ts`](../../packages/mcp/src/http.ts) `challenge` |
| Include `scope` in the 401 challenge (SHOULD) | Met | [`http.ts`](../../packages/mcp/src/http.ts) `challenge` |
| Validate every token, and that it was issued for this server | Met | `jwtVerify` with `issuer` and `audience` in [`packages/auth/src/mcp-auth.ts`](../../packages/auth/src/mcp-auth.ts); tests in [`packages/auth/src/oauth-flow.test.ts`](../../packages/auth/src/oauth-flow.test.ts) and [`apps/server/src/oauth-code.test.ts`](../../apps/server/src/oauth-code.test.ts) |
| Answer invalid or expired tokens with 401 | Met | Live: a wrong token gets 401 `invalid_token` |
| Answer insufficient scope with 403 | Met | `insufficient_scope` in [`packages/mcp/src/service.ts`](../../packages/mcp/src/service.ts) |
| No tokens in the query string | Met | `bearer_methods_supported: ["header"]`; live: `?access_token=` gets 401 |
| No token passthrough | Met | Tokens from an AI client are never sent upstream. Provider tokens are separate, stored encrypted ([`packages/security/src/envelope.ts`](../../packages/security/src/envelope.ts)) |
| No sessions used for authentication | Met | The server has no session ids; every request authenticates |
| Check `Origin` on the HTTP transport | Met | [`http.ts`](../../packages/mcp/src/http.ts) |
| State handles aren't authentication | Met | No state handles. Record ids in tool arguments are checked against the caller's grant |

## Authorization server

| Requirement | Status | Evidence |
|---|---|---|
| Publish authorization server metadata | Met | `/.well-known/oauth-authorization-server` |
| PKCE with S256 advertised | Met | `code_challenge_methods_supported: ["S256"]`; `clientRegistrationRequirePKCE` in [`packages/auth/src/auth.ts`](../../packages/auth/src/auth.ts) |
| Validate exact redirect URIs | Tested | A changed host, path, query or scheme gets no code, and the token endpoint refuses a different URI: [`packages/auth/src/oauth-negative.test.ts`](../../packages/auth/src/oauth-negative.test.ts) |
| Redirect URIs are localhost or HTTPS | Tested | Registration refuses plain http except on loopback: [`packages/auth/src/oauth-negative.test.ts`](../../packages/auth/src/oauth-negative.test.ts) |
| Rotate refresh tokens for public clients | Tested | A refresh issues a new token; replaying the old one fails and ends the newer one too: [`packages/auth/src/oauth-negative.test.ts`](../../packages/auth/src/oauth-negative.test.ts) |
| Short-lived access tokens (SHOULD) | Met | 1 hour |
| HTTPS on all endpoints | Met | `force_https`; HSTS on live |
| Support Client ID Metadata Documents (SHOULD) | Gap on hosted | Built behind `AGFN_OAUTH_CIMD`, off on hosted. Dynamic registration works, which the spec allows. When on, fetches are pinned and refuse private hosts |
| Send `iss` in the authorization response | Met | `authorization_response_iss_parameter_supported: true` |

## Consent and scopes

The rules for MCP proxies don't strictly apply: an AI client's sign-in doesn't forward to a third-party authorization
server, so the confused-deputy path doesn't exist here. We follow the parts that still make sense.

| Requirement | Status | Evidence |
|---|---|---|
| Per-client consent | Met | Pending grants are per client and session; red-team tests in [`packages/auth/src/oauth-redteam.test.ts`](../../packages/auth/src/oauth-redteam.test.ts) |
| Name the client on the consent page | Met | Shown and marked "unverified name" ([`apps/web/src/screens/ai.ts`](../../apps/web/src/screens/ai.ts)) |
| Show where the code goes | Met | "Sends you back to" the redirect's host |
| Show what's being asked for | Met | A sentence naming companies and data types |
| Stop the consent page being framed | Met | `x-frame-options: DENY` ([`apps/server/src/security.ts`](../../apps/server/src/security.ts)) |
| Minimal scopes | Met | `finance:read` and `records:write`, no wildcards. A grant narrows further to companies and data types. Step-up prompts aren't used: the person chooses at consent |

## Client-side rules

Rules for MCP clients, such as URL scheme checks and one-click install consent, are N/A: Aggregate is a server. The
`agfn mcp` bridge reads its key from the environment or a private file, never from the command line.

## Tool scan

Scanned on 2026-11-01 with [Cisco mcp-scanner](https://github.com/cisco-ai-defense/mcp-scanner) 4.8.7, YARA analyzer only,
against the public demo, which publishes the same tools: 40 tools, 0 findings. YARA rules are pattern matching, so that's
a check for known bad patterns, not proof of safety. The LLM and Cisco API analyzers weren't run.

Snyk Agent Scan wasn't run. It needs a Snyk account and sends tool descriptions to Snyk.
