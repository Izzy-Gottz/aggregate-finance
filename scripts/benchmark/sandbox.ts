// Arm A's analysis tool: run_python, the same for every model. Model-written code is untrusted, so each question gets
// a throwaway container with no network, a read-only root, the exports mounted read-only at /data, a small writable
// /tmp, and memory, CPU, process and time limits. Each call runs a fresh Python process in that container (files the
// model writes to /tmp persist for the rest of the question; variables don't).
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Tool } from './models.ts'

export const SANDBOX_IMAGE = process.env.BENCH_SANDBOX_IMAGE ?? 'agfn-bench-python:1'
const LIMITS = { memory: '512m', cpus: '1', pids: '64', tmp: '64m', callSeconds: 30, outputChars: 20_000 }

export const RUN_PYTHON: Tool = {
  name: 'run_python',
  description: [
    'Run Python 3 code and get back what it prints (stdout and stderr, cut at 20,000 characters).',
    'The company\'s exported files are in /data (read-only); pandas and numpy are installed. There is no internet.',
    'Each call is a new Python process: print what you need, and save intermediate files to /tmp if you want to reuse them.',
  ].join(' '),
  inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'Python 3 source to run.' } }, required: ['code'] },
}

export interface Sandbox { run(code: string): string; close(): void }

/** Start one sealed container for one question. */
export function openSandbox(exportsDir: string): Sandbox {
  const name = `agfn-bench-${randomBytes(6).toString('hex')}`
  execFileSync('docker', ['run', '-d', '--rm', '--name', name, '--network', 'none', '--read-only', '--memory', LIMITS.memory, '--memory-swap', LIMITS.memory,
    '--cpus', LIMITS.cpus, '--pids-limit', LIMITS.pids, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534',
    '--tmpfs', `/tmp:rw,size=${LIMITS.tmp},mode=1777`, '-v', `${exportsDir}:/data:ro`, '-w', '/tmp', SANDBOX_IMAGE, 'sleep', '3600'], { stdio: 'ignore' })
  return {
    run(code) {
      const r = spawnSync('docker', ['exec', '-i', name, 'timeout', '-s', 'KILL', String(LIMITS.callSeconds), 'python3', '-'], { input: code, encoding: 'utf8', maxBuffer: 1 << 24 })
      const out = `${r.stdout ?? ''}${r.stderr ? (r.stdout ? '\n' : '') + r.stderr : ''}`
      const killed = r.status === 137 ? `\n[stopped: the ${LIMITS.callSeconds}-second limit or the memory limit was reached]` : ''
      return (out.length > LIMITS.outputChars ? out.slice(0, LIMITS.outputChars) + '\n[output cut at 20,000 characters]' : out || '(no output)') + killed
    },
    close() { spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' }) },
  }
}

/** Versions recorded in each run: image digest and the Python and pandas inside it. */
export function sandboxVersions(): { image: string; digest: string; python: string; pandas: string } {
  const digest = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', SANDBOX_IMAGE], { encoding: 'utf8' }).trim()
  const v = execFileSync('docker', ['run', '--rm', '--network', 'none', SANDBOX_IMAGE, 'python3', '-c', 'import sys, pandas; print(sys.version.split()[0], pandas.__version__)'], { encoding: 'utf8' }).trim().split(' ')
  return { image: SANDBOX_IMAGE, digest, python: v[0]!, pandas: v[1]! }
}
