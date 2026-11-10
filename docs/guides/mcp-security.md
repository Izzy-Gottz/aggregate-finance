---
description: How Aggregate's MCP server maps to the OWASP MCP Top 10, its MCP security conformance status, and what scans have and haven't covered. A self-assessment, not a certification.
---

# MCP security: how Aggregate maps to the OWASP MCP Top 10

**Short answer:** this is our own assessment of Aggregate's MCP server against the
[OWASP MCP Top 10](https://owasp.org/projects/mcp-top-10) (2025, beta). OWASP hasn't reviewed it, nobody has certified
it, and no MCP certification exists. Each row says what we do and what's left, and the longer versions link to the code.

## The OWASP MCP Top 10

| Risk | What we do | What's left |
|---|---|---|
| MCP01 Token mismanagement and secret exposure | Provider tokens are encrypted per record. Agent keys are stored hashed and shown once. Access tokens last an hour | The master key is only as safe as its host |
| MCP02 Privilege escalation via scope creep | Grants name companies and data types, and write access is separate from read. Grants can be paused or revoked | |
| MCP03 Tool poisoning | The tool list is fixed in code and changes only through review | Scans check definitions, not behavior |
| MCP04 Supply chain attacks and dependency tampering | Lockfile, dependency audits, Dependabot security updates, pinned GitHub Actions, Docker base images pinned by digest, secret scanning, CodeQL | npm provenance isn't in place yet |
| MCP05 Command injection and execution | The MCP server code runs no shell commands, and no tool takes a command or a path to run | |
| MCP06 Prompt injection via contextual payloads | Text from banks, invoices and documents reaches the AI marked as untrusted, with a flag on suspicious patterns. Write tools can be held for a person's review | Pattern detection misses things. The AI client still decides what to do with the text |
| MCP07 Insufficient authentication and authorization | OAuth 2.1 with PKCE, audience-bound tokens, per-client consent | Client ID Metadata Documents are off on the hosted server |
| MCP08 Lack of audit and telemetry | Each AI call is logged with what it read or changed, and the owner can read the log in the app | |
| MCP09 Shadow MCP servers | The owner sees every connected AI and key in one list and can revoke them | This risk is mostly about servers an organization doesn't know it runs, which is the customer's to manage |
| MCP10 Context injection and over-sharing | Fields a grant doesn't cover are left out and listed as hidden. Personal money is left out of "all". Every read is limited to the workspace, in code and by row-level security | What an AI client does with data it was allowed to read is out of our hands |

The same table, with links to the code, is in [owasp-mcp-top-10.md](../security/owasp-mcp-top-10.md).

## MCP conformance status

We checked the hosted server against the MCP Authorization spec (version 2025-11-25) and the MCP Security Best Practices.
Each requirement is marked Met, Tested, Gap or N/A in [mcp-conformance.md](../security/mcp-conformance.md). There is one
open gap: Client ID Metadata Documents, a SHOULD in the spec, are built but off on the hosted server. Dynamic client
registration works, which the spec allows.

## What's been scanned

- **Tool definitions:** Cisco mcp-scanner 4.8.7, YARA and schema analyzers, on a local copy of the server: 40 tools, 0
  findings. Its LLM and Cisco API analyzers weren't run, and its prompt scan didn't complete.
- **Running app:** OWASP ZAP and Nuclei on a local copy with demo data: no real high or medium issue.
- **Not done yet:** scans of staging or the live service, and a test by an outside firm.

Details are in [scan-2026-11.md](../security/scan-2026-11.md). Scanners catch known patterns, so a clean result isn't
proof of safety.

To report a problem, see [SECURITY.md](https://github.com/Izzy-Gottz/aggregate-finance/blob/main/SECURITY.md).

Last checked 2026-11-02.
