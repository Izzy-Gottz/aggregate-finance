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
- **Stripe App installs: tiered prices are left out of MRR until App v1.0.1** (2026-10-15). Reading a price's tiers
  (`expand[]=data.price.tiers`) needs the App's `plan_read` permission, which v0.0.2 (in review) doesn't have. Sync
  doesn't fail: tiered items are left out of MRR with a warning. Restricted keys with Prices read are unaffected.
  v1.0.1 adds `plan_read` (branch `slice/stripe-app-v101`, not merged) and is submitted right after the current review
  is approved; installs then grant it on update.
