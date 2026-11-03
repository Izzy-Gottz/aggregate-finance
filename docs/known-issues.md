# Known issues

Small, understood behaviors we've chosen to leave as they are. Each says why it's safe.

- **OAuth: revoking an access token after its refresh token answers 400** (seen by QA on staging, 2026-10-11). Better
  Auth's `/api/auth/oauth2/revoke` no longer recognizes the access token once its refresh token is revoked. Safe:
  revoking the refresh token already ended the grant, and the MCP host re-reads the grant on every call, so the access
  token stops working either way.
- **OAuth: a token issued without `resource=<base>/mcp` is refused by /mcp** (`invalid_token`). Correct per RFC 8707
  (tokens are bound to the resource they were issued for); Claude and ChatGPT both send it.
- **`share_answer` is built but stays off** (`AGFN_MCP_SHARE`). Decided 2026-10-12: no new tools, even after the
  directory reviews close. Sharing stays in the web app's cards.
- **Stripe tiered prices need `plan_read` or Prices read** (updated 2026-11-02). The Stripe App has had `plan_read` since
  v1.0.1 (published as 1.0.3 on 2026-10-26). A key without that access still syncs: tiered items are left out of MRR
  with a warning.
