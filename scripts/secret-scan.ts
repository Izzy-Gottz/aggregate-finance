// Secret scan of the whole git history and the working tree, with nothing to install (launch packet §9, step 1).
//
//   node scripts/secret-scan.ts            history (`git log -p --all`) + tracked files + .env files ever committed
//   node scripts/secret-scan.ts --tree     tracked files only (fast)
//
// Prints file, commit and pattern name only, never the matched value, so its output is safe to paste anywhere.
// Exit 1 when anything is found. A line can opt out with the comment `secret-scan: ignore` (for documented fakes).

import { spawn, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

interface Rule {
  name: string
  re: RegExp
  /** For named-variable rules: the captured value must look random, not like a placeholder. */
  value?: number
}

// Values that are obviously not secrets (placeholders, examples, env lookups, template strings).
const PLACEHOLDER = /^(x+|0+|1+|a+|changeme|change-me|secret|password|placeholder|example|test|dummy|fake|redacted|your[-_].*|<.*>|\$\{.*|\$[A-Z_]+|process\.env.*|env\..*|\*+|\.\.\.|…)$/i

const RULES: Rule[] = [
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'AWS/R2 secret access key', re: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|R2_SECRET_ACCESS_KEY|S3_SECRET(?:_ACCESS)?_KEY)["']?\s*[:=]\s*["'`]?([A-Za-z0-9/+=]{32,})/, value: 1 },
  { name: 'Stripe secret/restricted key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { name: 'Stripe test secret key', re: /\b(?:sk|rk)_test_[A-Za-z0-9]{20,}/ },
  { name: 'Stripe webhook secret', re: /\bwhsec_[A-Za-z0-9]{24,}/ },
  { name: 'Plaid secret', re: /PLAID_SECRET["']?\s*[:=]\s*["'`]?([a-f0-9]{30})\b/, value: 1 },
  { name: 'Plaid access token', re: /\baccess-(?:sandbox|development|production)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/ },
  { name: 'Resend API key', re: /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/ },
  { name: 'Postgres URL with password', re: /\bpostgres(?:ql)?:\/\/[^:\s/'"`@]+:([^@\s'"`]{8,})@([^/\s'"`:]+)/, value: 1 },
  { name: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}/ },
  { name: 'Fly.io token', re: /\bFlyV1 fm[12]_[A-Za-z0-9+/=_-]{20,}/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Aggregate agent key', re: /\bagfn_live_([A-Za-z0-9_-]{24,})/, value: 1 },
  {
    name: 'named secret (AUTH_SECRET, AGFN_MASTER_KEY, *_CLIENT_SECRET, *_API_KEY, *_TOKEN)',
    re: /\b(AUTH_SECRET|AGFN_MASTER_KEY|BETTER_AUTH_SECRET|[A-Z][A-Z0-9_]*_(?:CLIENT_SECRET|API_KEY|SECRET_KEY|SECRET|TOKEN|PASSWORD))["']?\s*[:=]\s*["'`]?([A-Za-z0-9+/_=.-]{20,})/,
    value: 2,
  },
]

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length)
  return h
}

function looksRandom(v: string): boolean {
  const s = v.replace(/["'`,;)]+$/, '')
  if (PLACEHOLDER.test(s)) return false
  if (/^(.)\1+$/.test(s) || /^[a-z]+(?:[-_][a-z]+)*$/.test(s)) return false // repeated char, or plain words like "my-dev-secret"
  // A short string can't score high (16 random characters average ~3.7 bits), and hex tops out at 4 bits per character,
  // so the bar scales with length. Checked against 50,000 random values per shape: none of 12+ characters slips under.
  const bar = /^[0-9a-f]+$/i.test(s) ? Math.min(3, 0.55 * Math.log2(s.length)) : Math.min(3.5, 0.7 * Math.log2(s.length))
  return entropy(s) >= bar
}

// Documented fakes: AWS's own example key, values that spell out that they're examples.
const FAKE = /EXAMPLE|example|Example|fake|Fake|FAKE|dummy|Dummy|placeholder|redacted/
const KEY_BODY = /[A-Za-z0-9+/=]{40,}/

/** One file's (or one diff's) lines in order: a private key header counts only when key material follows it. */
function scanner(host?: (h: string) => boolean) {
  let pendingKey = false
  return (line: string): string[] => {
    if (line.includes('secret-scan: ignore')) return []
    const found: string[] = []
    if (pendingKey) {
      pendingKey = false
      if (/^\s*["'`]?[A-Za-z0-9+/=]{40,}/.test(line)) found.push('private key block')
    }
    for (const r of RULES) {
      const m = r.re.exec(line)
      if (!m) continue
      if (FAKE.test(m[r.value ?? 0]!)) continue
      if (r.name === 'private key block') {
        const after = line.slice(m.index + m[0].length)
        if (KEY_BODY.test(after.replace(/\\n/g, ''))) found.push(r.name)
        else if (!after.trim() || /^\s*["'`]?\s*$/.test(after) || /^\\n["'`]?$/.test(after.trim())) pendingKey = true
        continue
      }
      // A property read is code, not a value: `JUSTWORKS_CLIENT_SECRET: SECRETS.JUSTWORKS_CLIENT_SECRET`, process.env.X.
      if (r.value !== undefined && /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(m[r.value]!)) continue
      if (r.value !== undefined && !looksRandom(m[r.value]!)) continue
      if (r.name === 'Postgres URL with password' && host && !host(m[2]!)) continue
      found.push(r.name)
    }
    return found
  }
}

// Local Postgres URLs in tests and CI (postgres:postgres@localhost) are not secrets.
const remoteHost = (h: string) => !/^(localhost|127\.0\.0\.1|0\.0\.0\.0|postgres|db|::1|\[::1\])$/.test(h)

type Finding = { pattern: string; file: string; commit: string }
const findings = new Map<string, Finding & { count: number }>()
function add(f: Finding) {
  const key = `${f.pattern}\0${f.file}\0${f.commit}`
  const cur = findings.get(key)
  if (cur) cur.count++
  else findings.set(key, { ...f, count: 1 })
}

const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30 })

async function scanHistory(): Promise<number> {
  // Only added lines matter: a removed line was added in an earlier commit and is reported there.
  const child = spawn('git', ['log', '-p', '--all', '--no-color', '--no-ext-diff', '--format=commit %H', '-U0'], { stdio: ['ignore', 'pipe', 'inherit'] })
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  let commit = ''
  let file = ''
  let commits = 0
  let scan = scanner(remoteHost)
  for await (const line of rl) {
    if (line.startsWith('commit ')) {
      commit = line.slice(7, 19)
      commits++
    } else if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : line.slice(4)
      scan = scanner(remoteHost)
    } else if (line.startsWith('+') && !line.startsWith('+++')) for (const p of scan(line.slice(1))) add({ pattern: p, file, commit })
  }
  await new Promise((res) => child.on('close', res))
  return commits
}

function scanTree(): number {
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean)
  for (const f of files) {
    let text: string
    try {
      const buf = readFileSync(f)
      if (buf.includes(0)) continue // binary
      text = buf.toString('utf8')
    } catch {
      continue
    }
    const scan = scanner(remoteHost)
    for (const line of text.split('\n')) for (const p of scan(line)) add({ pattern: p, file: f, commit: 'working tree' })
  }
  return files.length
}

function scanEnvFiles(): void {
  // Any .env file that was ever committed (examples excepted), whatever it contains.
  const out = git(['log', '--all', '--no-color', '--diff-filter=A', '--name-only', '--format=commit %H'])
  let commit = ''
  for (const line of out.split('\n')) {
    if (line.startsWith('commit ')) commit = line.slice(7, 19)
    else if (/(^|\/)\.env(\.[^/]*)?$/.test(line) && !/\.(example|sample|template)$/.test(line)) add({ pattern: '.env file committed', file: line, commit })
  }
}

const treeOnly = process.argv.includes('--tree')
const tracked = scanTree()
let commits = 0
if (!treeOnly) {
  commits = await scanHistory()
  scanEnvFiles()
}

const rows = [...findings.values()].sort((a, b) => a.pattern.localeCompare(b.pattern) || a.file.localeCompare(b.file))
console.log(`secret scan: ${tracked} tracked files${treeOnly ? '' : `, ${commits} commits (all refs)`}; ${rows.length} finding(s). Values are never printed.`)
for (const r of rows) console.log(`  ${r.pattern} · ${r.file} · ${r.commit}${r.count > 1 ? ` (${r.count} lines)` : ''}`)
process.exit(rows.length ? 1 : 0)
