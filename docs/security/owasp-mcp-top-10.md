# OWASP MCP Top 10: self-assessment

Our own assessment against the [OWASP MCP Top 10](https://owasp.org/www-project-mcp-top-10/) (2025, beta), done on
2026-11-01. OWASP hasn't reviewed it. Read OWASP's page for what each risk means; this table says only what we do.

| Risk | What we do | Where | What's left |
|---|---|---|---|
| MCP01 | Provider tokens are encrypted per record. Agent keys are stored hashed and shown once. Access tokens last an hour | [`envelope.ts`](../../packages/security/src/envelope.ts), [`keys.ts`](../../packages/mcp/src/keys.ts) | The master key is only as safe as its host |
| MCP02 | Grants name companies and data types, and write access is separate from read. Grants can be paused or revoked | [`service.ts`](../../packages/mcp/src/service.ts), [`scope.ts`](../../packages/mcp/src/scope.ts) | |
| MCP03 | The tool list is fixed in code and changes only through review. Scan results are in [mcp-conformance.md](mcp-conformance.md) | [`tools/`](../../packages/mcp/src/tools) | Glama and the YARA scan check definitions, not behavior |
| MCP04 | Lockfile, `npm audit` in CI, Dependabot security updates, pinned GitHub Actions, gitleaks, CodeQL | [`.github/workflows`](../../.github/workflows) | npm provenance isn't in place yet. Docker base images aren't pinned by digest |
| MCP05 | The MCP server code runs no shell commands, and no tool takes a command or a path to run | [`packages/mcp`](../../packages/mcp) | |
| MCP06 | Text from banks, invoices and documents reaches the AI marked as untrusted, with a flag on suspicious patterns. Write tools can be held for a person's review | [`untrusted.ts`](../../packages/mcp/src/untrusted.ts) | Pattern detection misses things. The AI client still decides what to do with the text |
| MCP07 | OAuth 2.1 with PKCE, audience-bound tokens, per-client consent. See [mcp-conformance.md](mcp-conformance.md) | [`mcp-auth.ts`](../../packages/auth/src/mcp-auth.ts) | Gaps are listed on that page |
| MCP08 | Each AI call is logged with what it read or changed, and the owner can read the log in the app | [`service.ts`](../../packages/mcp/src/service.ts) | |
| MCP09 | The owner sees every connected AI and key in one list and can revoke them | [`apps/web/src/screens/ai.ts`](../../apps/web/src/screens/ai.ts) | This risk is about MCP servers an organization doesn't know it runs, which is mostly the customer's to manage |
| MCP10 | Fields a grant doesn't cover are left out and listed as hidden. Personal money is left out of "all". Every read is limited to the workspace, in code and by row-level security | [`scope.ts`](../../packages/mcp/src/scope.ts), [rls.md](rls.md) | What an AI client does with data it was allowed to read is out of our hands |
