// scripts/deploy-aws.sh: the order (release step before anything switches), and what every failure leaves behind.
// The first suite runs the real script with stand-in docker/curl/ss on PATH, so each branch is exercised everywhere.
// The second (AGFN_TEST_DEPLOY_DOCKER=1, needs docker and caddy) runs it for real: a small image, the real
// deploy/aws/Caddyfile in a real Caddy, traffic through Caddy during the swap (zero non-200), and a failing release step
// that leaves the old container serving.
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = new URL('./deploy-aws.sh', import.meta.url).pathname
const CADDYFILE = new URL('../deploy/aws/Caddyfile', import.meta.url).pathname

const run = (env: Record<string, string>, ...args: string[]) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    execFile('bash', [SCRIPT, ...args], { env: { ...env, HOME: process.env.HOME ?? '/tmp' } }, (e, stdout, stderr) =>
      resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    )
  })

describe('deploy-aws.sh (stand-in docker)', () => {
  let dir: string
  let env: Record<string, string>
  const log = () => readFileSync(join(dir, 'log'), 'utf8')
  const upstream = () => (existsSync(join(dir, 'caddy/upstream.caddy')) ? readFileSync(join(dir, 'caddy/upstream.caddy'), 'utf8').trim() : '')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agfn-deploy-'))
    mkdirSync(join(dir, 'bin'))
    mkdirSync(join(dir, 'caddy'))
    writeFileSync(join(dir, 'log'), '')
    writeFileSync(join(dir, 'env'), 'AUTH_SECRET=stand-in\n', { mode: 0o600 })
    const bin = (name: string, body: string) => {
      writeFileSync(join(dir, 'bin', name), `#!/usr/bin/env bash\n${body}\n`)
      chmodSync(join(dir, 'bin', name), 0o755)
    }
    // docker: logs each call; `run --rm` is the release step; `run -d` remembers the published port for `port`.
    bin(
      'docker',
      `echo "docker $*" >> "$D/log"
case "$1" in
  run)
    if [ "$2" = "--rm" ]; then exit "\${FAKE_RELEASE_EXIT:-0}"; fi
    name=""; pub=""; prev=""
    for a in "$@"; do [ "$prev" = "--name" ] && name=$a; [ "$prev" = "-p" ] && pub=$a; prev=$a; done
    echo "$pub" > "$D/pub-$name"; touch "$D/ctr-$name"; echo id ;;
  port) p=$(cut -d: -f1,2 < "$D/pub-$2"); echo "8787/tcp -> \${FAKE_PUBLISH:-$p}" ;;
  inspect) [ -f "$D/ctr-$2" ] ;;
  image) case "$*" in *RepoDigests*) echo "\${FAKE_DIGEST:-}" ;; *revision*) echo "\${FAKE_LABEL_SHA:-<no value>}" ;; esac; exit 0 ;;
  rm) rm -f "$D/ctr-$3"; exit 0 ;;
  *) exit 0 ;;
esac`,
    )
    bin('curl', 'echo "curl $*" >> "$D/log"; printf %s "${FAKE_HEALTH:-200}"')
    bin('ss', '[ -n "${FAKE_LISTEN:-}" ] && echo "LISTEN 0 4096 $FAKE_LISTEN *:*"; exit 0')
    bin('lsof', '[ -n "${FAKE_LISTEN:-}" ] && printf "COMMAND PID\\nx 1 u 3u IPv4 0 0t0 TCP %s (LISTEN)\\n" "$FAKE_LISTEN"; exit 0')
    env = {
      PATH: `${join(dir, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
      D: dir,
      AGFN_ENV_FILE: join(dir, 'env'),
      AGFN_STATE_DIR: join(dir, 'state'),
      AGFN_CADDY_DIR: join(dir, 'caddy'),
      AGFN_CADDY_RELOAD: `echo reload >> ${join(dir, 'log')}`,
      AGFN_DRAIN_S: '0',
      AGFN_HEALTH_S: '3',
    }
  })

  it('first deploy: release step, then start on blue (loopback only), health, switch; records the image', async () => {
    const r = await run(env, 'deploy', 'registry/agfn:abc123')
    expect(r.out).toMatch(/serving: nothing; new: agfn-blue on 8787/)
    expect(r.out).toMatch(/ok: agfn-blue serves registry\/agfn:abc123/)
    expect(r.code).toBe(0)
    const calls = log().split('\n')
    const release = calls.findIndex((l) => l.startsWith('docker run --rm') && l.includes('apps/server/src/release.ts'))
    const start = calls.findIndex((l) => l.startsWith('docker run -d'))
    const reload = calls.indexOf('reload')
    expect(release).toBeGreaterThan(-1)
    expect(start).toBeGreaterThan(release)
    expect(reload).toBeGreaterThan(start)
    expect(calls[start]).toMatch(/-p 127\.0\.0\.1:8787:8787 /)
    expect(calls[start]).not.toMatch(/9091/)
    // The same fresh release id for the release step and the server.
    const ids = calls.filter((l) => l.startsWith('docker run')).map((l) => /AGFN_RELEASE=(\S+)/.exec(l)?.[1])
    expect(ids[0]).toMatch(/^abc123-\d{8}T\d{6}Z$/)
    expect(ids[1]).toBe(ids[0])
    expect(upstream()).toBe('to 127.0.0.1:8787')
    expect(readFileSync(join(dir, 'state/current-image'), 'utf8').trim()).toBe('registry/agfn:abc123')
  })

  it('second deploy goes to green, then drains and stops blue; rollback brings the first image back on blue', async () => {
    await run(env, 'deploy', 'registry/agfn:v1')
    writeFileSync(join(dir, 'log'), '')
    const r = await run(env, 'deploy', 'registry/agfn:v2')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/serving: agfn-blue on 8787; new: agfn-green on 8788/)
    expect(upstream()).toBe('to 127.0.0.1:8788')
    expect(log()).toMatch(/docker run -d --name agfn-green/)
    expect(log()).toMatch(/docker stop -t 30 agfn-blue/)
    // Stopped after the switch, not before.
    expect(log().indexOf('reload')).toBeLessThan(log().indexOf('docker stop'))
    expect(readFileSync(join(dir, 'state/previous-image'), 'utf8').trim()).toBe('registry/agfn:v1')

    const back = await run(env, 'rollback')
    expect(back.code).toBe(0)
    expect(back.out).toMatch(/rolling back to registry\/agfn:v1/)
    expect(upstream()).toBe('to 127.0.0.1:8787')
    expect(readFileSync(join(dir, 'state/current-image'), 'utf8').trim()).toBe('registry/agfn:v1')
    expect((await run(env, 'status')).out).toMatch(/serving: agfn-blue on 127\.0\.0\.1:8787[\s\S]*previous: registry\/agfn:v2/)
  })

  it('a placeholder upstream (not blue or green) counts as nothing serving', async () => {
    writeFileSync(join(dir, 'caddy/upstream.caddy'), 'to 127.0.0.1:1\n')
    const r = await run(env, 'deploy', 'registry/agfn:v1')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/serving: nothing; new: agfn-blue on 8787/)
    expect(r.out).toMatch(/6\/6 no old container/)
  })

  it('a failing release step (migration) changes nothing: no new container, no switch, the old one keeps serving', async () => {
    await run(env, 'deploy', 'registry/agfn:v1')
    writeFileSync(join(dir, 'log'), '')
    const r = await run({ ...env, FAKE_RELEASE_EXIT: '1' }, 'deploy', 'registry/agfn:v2')
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/release step failed; nothing switched, agfn-blue still serving/)
    expect(log()).not.toMatch(/docker run -d|reload|docker stop|docker rm/)
    expect(upstream()).toBe('to 127.0.0.1:8787')
    expect(readFileSync(join(dir, 'state/current-image'), 'utf8').trim()).toBe('registry/agfn:v1')
  })

  it('a new container that never gets healthy is removed; no switch', async () => {
    await run(env, 'deploy', 'registry/agfn:v1')
    writeFileSync(join(dir, 'log'), '')
    const r = await run({ ...env, FAKE_HEALTH: '503', AGFN_HEALTH_S: '2' }, 'deploy', 'registry/agfn:v2')
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/agfn-green never became healthy; removed it, nothing switched, agfn-blue still serving/)
    expect(log()).toMatch(/docker rm -f agfn-green/)
    expect(log()).not.toMatch(/reload|docker stop/)
    expect(upstream()).toBe('to 127.0.0.1:8787')
  })

  it('a container that publishes anything beyond its loopback port is removed before it gets traffic', async () => {
    const r = await run({ ...env, FAKE_PUBLISH: '0.0.0.0:8787' }, 'deploy', 'registry/agfn:v1')
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/publishes more than 127\.0\.0\.1:8787/)
    expect(log()).not.toMatch(/reload/)
    expect(upstream()).toBe('')
  })

  it('a failed Caddy reload restores the previous upstream and removes the new container', async () => {
    await run(env, 'deploy', 'registry/agfn:v1')
    writeFileSync(join(dir, 'log'), '')
    const r = await run({ ...env, AGFN_CADDY_RELOAD: 'false' }, 'deploy', 'registry/agfn:v2')
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/Caddy reload failed; upstream restored/)
    expect(upstream()).toBe('to 127.0.0.1:8787')
    expect(log()).toMatch(/docker rm -f agfn-green/)
    expect(log()).not.toMatch(/docker stop/)
  })

  it('fails loudly when the metrics port listens beyond loopback', async () => {
    const r = await run({ ...env, FAKE_LISTEN: '0.0.0.0:9091' }, 'deploy', 'registry/agfn:v1')
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/something listens on :9091 beyond loopback/)
    expect((await run({ ...env, FAKE_LISTEN: '127.0.0.1:9091' }, 'deploy', 'registry/agfn:v2')).code).toBe(0)
  })

  it('Parameter Store: values go into a 0600 file that is removed afterwards, and are never printed', async () => {
    writeFileSync(
      join(dir, 'bin', 'aws'),
      `#!/usr/bin/env bash\nprintf '/agfn/live/AUTH_SECRET\\tsecret-value-xyz\\n/agfn/live/DATABASE_URL\\tpostgres://u:p@h/db?sslmode=require\\n'\n`,
    )
    chmodSync(join(dir, 'bin', 'aws'), 0o755)
    const ssm = { ...env, AGFN_ENV_FILE: '', AGFN_SSM_PATH: '/agfn/live', TMPDIR: join(dir, 'tmp') }
    mkdirSync(join(dir, 'tmp'))
    // Catch the env file while the release step runs: the stand-in copies it.
    writeFileSync(join(dir, 'bin', 'docker'), readFileSync(join(dir, 'bin', 'docker'), 'utf8').replace('if [ "$2" = "--rm" ]; then', 'if [ "$2" = "--rm" ]; then f=""; prev=""; for a in "$@"; do [ "$prev" = "--env-file" ] && f=$a; prev=$a; done; cp "$f" "$D/seen-env"; stat -c %a "$f" > "$D/seen-mode" 2>/dev/null || stat -f %Lp "$f" > "$D/seen-mode";'))
    const r = await run(ssm, 'deploy', 'registry/agfn:v1')
    expect(r.code).toBe(0)
    expect(r.out).not.toMatch(/secret-value-xyz|u:p@/)
    expect(readFileSync(join(dir, 'seen-env'), 'utf8')).toBe('AUTH_SECRET=secret-value-xyz\nDATABASE_URL=postgres://u:p@h/db?sslmode=require\n')
    expect(readFileSync(join(dir, 'seen-mode'), 'utf8').trim()).toBe('600')
    expect(execFileSync('ls', [join(dir, 'tmp')]).toString().trim()).toBe('')
  })

  const records = () => readFileSync(join(dir, 'state/deploys.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, string>)

  it('records every deploy and rollback, finished or failed, as one JSON line in a 0600 file', async () => {
    const e = { ...env, FAKE_DIGEST: 'registry/agfn@sha256:abc', AGFN_GIT_SHA: '1234abcd', AGFN_DEPLOY_BY: 'founder' }
    expect((await run(e, 'deploy', 'registry/agfn:v1')).code).toBe(0)
    expect((await run({ ...e, FAKE_RELEASE_EXIT: '1' }, 'deploy', 'registry/agfn:v2')).code).not.toBe(0)
    expect((await run(e, 'deploy', 'registry/agfn:v2')).code).toBe(0)
    expect((await run(e, 'rollback')).code).toBe(0)
    const r = records()
    expect(r.map((x) => [x.action, x.image, String(x.result).slice(0, 27)])).toEqual([
      ['deploy', 'registry/agfn:v1', 'ok'],
      ['deploy', 'registry/agfn:v2', 'failed: release step failed'],
      ['deploy', 'registry/agfn:v2', 'ok'],
      ['rollback', 'registry/agfn:v1', 'ok'],
    ])
    for (const x of r) {
      expect(x.time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
      expect(x.release).toMatch(/^v[12]-\d{8}T\d{6}Z$/)
      expect(x).toMatchObject({ digest: 'registry/agfn@sha256:abc', git_sha: '1234abcd', who: 'founder' })
    }
    expect(statSync(join(dir, 'state/deploys.jsonl')).mode & 0o777).toBe(0o600)
  })

  it('the record falls back to the image label for the commit, and still records a failure before the release id exists', async () => {
    expect((await run({ ...env, FAKE_LABEL_SHA: 'feedface' }, 'deploy', 'registry/agfn:v1')).code).toBe(0)
    expect(records()[0]).toMatchObject({ git_sha: 'feedface', result: 'ok' })
    expect((await run({ ...env, AGFN_ENV_FILE: join(dir, 'missing') }, 'deploy', 'registry/agfn:v2')).code).not.toBe(0)
    expect(records()[1]).toMatchObject({ image: 'registry/agfn:v2', git_sha: 'unknown', release: '' })
    expect(records()[1]?.result).toMatch(/^failed: AGFN_ENV_FILE .* is not readable/)
  })

  it('sends the same line to CloudWatch when AGFN_DEPLOY_LOG_GROUP is set; a CloudWatch failure is only a warning', async () => {
    writeFileSync(join(dir, 'bin', 'aws'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "$D/aws-args"\n[ "$2" = put-log-events ] && exit "\${FAKE_CW_EXIT:-0}"\nexit 0\n`)
    chmodSync(join(dir, 'bin', 'aws'), 0o755)
    const e = { ...env, AGFN_DEPLOY_LOG_GROUP: '/agfn/deploys' }
    expect((await run(e, 'deploy', 'registry/agfn:v1')).code).toBe(0)
    const args = readFileSync(join(dir, 'aws-args'), 'utf8').split('\n')
    expect(args).toContain('/agfn/deploys')
    const events = JSON.parse(args[args.indexOf('--log-events') + 1]!) as Array<{ timestamp: number; message: string }>
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.message)).toEqual(records()[0])
    const failed = await run({ ...e, FAKE_CW_EXIT: '1' }, 'deploy', 'registry/agfn:v2')
    expect(failed.code).toBe(0)
    expect(failed.out).toMatch(/didn't reach CloudWatch \(\/agfn\/deploys\)/)
    expect(records()).toHaveLength(2)
  })

  it('refuses a parameter with a bad name, without printing values', async () => {
    writeFileSync(join(dir, 'bin', 'aws'), `#!/usr/bin/env bash\nprintf '/agfn/live/bad-name\\tsecret-value-xyz\\n'\n`)
    chmodSync(join(dir, 'bin', 'aws'), 0o755)
    const r = await run({ ...env, AGFN_ENV_FILE: '', AGFN_SSM_PATH: '/agfn/live' }, 'deploy', 'registry/agfn:v1')
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/bad name or a multi-line value/)
    expect(r.out).not.toMatch(/secret-value-xyz/)
    expect(log()).not.toMatch(/docker run/)
  })
})

// ---------- for real ----------

const has = (cmd: string, ...args: string[]) => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const REAL = process.env.AGFN_TEST_DEPLOY_DOCKER === '1' && has('docker', 'info') && has('caddy', 'version')
const BASE_IMAGE = process.env.AGFN_TEST_DEPLOY_BASE ?? 'node:22-bookworm-slim'

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })

describe.skipIf(!REAL)('deploy-aws.sh for real (docker + Caddy)', () => {
  let dir: string
  let caddy: ChildProcess
  let site: number
  let admin: number
  let env: Record<string, string>
  const tag = `agfn-deploy-test-${process.pid}`
  const name = `agfndt${process.pid}`

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agfn-deploy-real-'))
    // A stand-in app: /healthz answers 200 a second after start; / says which version; the release step exits with
    // FAIL_RELEASE (a failing migration).
    mkdirSync(join(dir, 'img/apps/server/src'), { recursive: true })
    writeFileSync(join(dir, 'img/package.json'), '{"type":"module"}')
    writeFileSync(
      join(dir, 'img/apps/server/src/main.js'),
      `import http from 'node:http'; const up = Date.now(); http.createServer((q, s) => { if (q.url === '/healthz') { s.statusCode = Date.now() - up > 1000 ? 200 : 503; return s.end() } setTimeout(() => s.end(process.env.VERSION), 20) }).listen(8787)`,
    )
    writeFileSync(join(dir, 'img/apps/server/src/release.ts'), `process.exit(Number(process.env.FAIL_RELEASE ?? 0))`)
    writeFileSync(
      join(dir, 'img/Dockerfile'),
      `FROM ${BASE_IMAGE}\nWORKDIR /app\nCOPY . .\nARG VERSION\nENV VERSION=$VERSION\nCMD ["node", "apps/server/src/main.js"]\n`,
    )
    for (const v of ['v1', 'v2', 'v3']) execFileSync('docker', ['build', '-q', '--build-arg', `VERSION=${v}`, '-t', `${tag}:${v}`, join(dir, 'img')], { stdio: 'ignore' })
    site = await freePort()
    admin = await freePort()
    mkdirSync(join(dir, 'caddy'))
    // The real Caddyfile, with a test site address and admin port.
    writeFileSync(join(dir, 'caddy/Caddyfile'), `{\n\tadmin 127.0.0.1:${admin}\n\tauto_https off\n}\n` + readFileSync(CADDYFILE, 'utf8'))
    writeFileSync(join(dir, 'caddy/upstream.caddy'), 'to 127.0.0.1:1\n')
    writeFileSync(join(dir, 'env'), 'NODE_ENV=production\n', { mode: 0o600 })
    const caddyEnv = { ...process.env, AGFN_SITE: `http://127.0.0.1:${site}`, AGFN_CADDY_DIR: join(dir, 'caddy') }
    caddy = spawn('caddy', ['run', '--config', join(dir, 'caddy/Caddyfile'), '--adapter', 'caddyfile'], { env: caddyEnv, stdio: 'ignore' })
    for (let i = 0; i < 50; i++) {
      if (await fetch(`http://127.0.0.1:${admin}/config/`).then(() => true, () => false)) break
      await new Promise((r) => setTimeout(r, 100))
    }
    env = {
      PATH: process.env.PATH ?? '',
      AGFN_ENV_FILE: join(dir, 'env'),
      AGFN_STATE_DIR: join(dir, 'state'),
      AGFN_CADDY_DIR: join(dir, 'caddy'),
      AGFN_CADDY_RELOAD: `AGFN_SITE=http://127.0.0.1:${site} AGFN_CADDY_DIR=${join(dir, 'caddy')} caddy reload --config ${join(dir, 'caddy/Caddyfile')} --adapter caddyfile --address 127.0.0.1:${admin}`,
      AGFN_DRAIN_S: '3',
      AGFN_HEALTH_S: '30',
      AGFN_NAME: name,
      AGFN_NO_PULL: '1',
    }
  }, 300_000)

  afterAll(() => {
    caddy?.kill()
    const quiet = (...a: string[]) => {
      try {
        execFileSync('docker', a, { stdio: 'ignore' })
      } catch {
        // already gone
      }
    }
    quiet('rm', '-f', `${name}-blue`, `${name}-green`, `${name}-release`)
    quiet('rmi', '-f', `${tag}:v1`, `${tag}:v2`, `${tag}:v3`)
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const get = () =>
    fetch(`http://127.0.0.1:${site}/`).then(
      async (r) => ({ status: r.status, body: await r.text() }),
      () => ({ status: 0, body: '' }),
    )

  it('swaps v1 → v2 under steady traffic with no failed request, then refuses v3 (failing migration) and keeps v2', async () => {
    const first = await run(env, 'deploy', `${tag}:v1`)
    expect(first.out).toMatch(/ok: /)
    expect((await get()).body).toBe('v1')

    // Steady traffic through Caddy for the whole second deploy.
    const seen: Array<{ status: number; body: string }> = []
    let going = true
    const load = (async () => {
      while (going) seen.push(...(await Promise.all([get(), get(), get(), get()])))
    })()
    const second = await run(env, 'deploy', `${tag}:v2`)
    await new Promise((r) => setTimeout(r, 500))
    going = false
    await load
    expect(second.out).toMatch(/ok: /)
    expect(second.code).toBe(0)
    expect(seen.length).toBeGreaterThan(100)
    expect(seen.filter((s) => s.status !== 200)).toEqual([])
    expect(seen.some((s) => s.body === 'v1')).toBe(true)
    expect(seen.at(-1)?.body).toBe('v2')

    writeFileSync(join(dir, 'env-fail'), 'FAIL_RELEASE=1\n', { mode: 0o600 })
    const failing = await run({ ...env, AGFN_ENV_FILE: join(dir, 'env-fail') }, 'deploy', `${tag}:v3`)
    expect(failing.code).not.toBe(0)
    expect(failing.out).toMatch(/release step failed/)
    expect((await get()).body).toBe('v2')
  }, 300_000)
})
