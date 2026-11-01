#!/bin/sh
# Builds the OpenAI plugin ZIP (docs/compliance/mcp-directory.md §5) from openai-plugin/: plugin.json at the ZIP root,
# mcp.json (one remote server, OAuth with DCR, no secrets), assets/. Refuses while the demo video URL is still a TODO.
#   sh scripts/build-openai-plugin.sh      → dist/aggregate-openai-plugin.zip
set -eu
cd "$(dirname "$0")/.."
SRC=openai-plugin
OUT=dist/aggregate-openai-plugin.zip
node -e '
const p = require("./openai-plugin/plugin.json"), m = require("./openai-plugin/mcp.json")
const o = p.extensions["com.openai"], i = o.interface, r = o.review
const problems = []
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.name) || p.name.length > 64) problems.push("name")
if (!/^\d+\.\d+\.\d+$/.test(p.version)) problems.push("version (explicit semver)")
for (const [k, n] of [["displayName", 30], ["shortDescription", 30], ["longDescription", 4000], ["developerName", 80]]) if (!i[k] || i[k].length > n) problems.push(`${k} (max ${n})`)
for (const k of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) if (!/^https:\/\//.test(i[k] || "")) problems.push(k)
if ((i.defaultPrompt || []).some((x) => x.length > 128) || (i.defaultPrompt || []).length > 3) problems.push("defaultPrompt")
if (r.test_cases.positive.length !== 5 || r.test_cases.negative.length !== 3) problems.push("test cases (exactly 5 + 3)")
if (r.test_cases.positive.some((c) => !c.prompt || !c.tools_triggered?.length || !c.expected_behavior)) problems.push("positive case fields")
if (!/^https:\/\//.test(r.demo_recording_url || "")) problems.push("review.demo_recording_url (record it: scripts/screencast/chatgpt.mjs)")
const servers = Object.values(m.mcpServers)
if (servers.length !== 1) problems.push("exactly one MCP server")
if (JSON.stringify(m).match(/clientSecret|clientId|"headers"/)) problems.push("mcp.json must hold no client credentials or headers")
if (problems.length) { console.error("Not ready:\n  - " + problems.join("\n  - ")); process.exit(1) }
'
mkdir -p dist
rm -f "$OUT"
(cd "$SRC" && zip -qr "../$OUT" plugin.json mcp.json assets -x '.*')
unzip -l "$OUT"
