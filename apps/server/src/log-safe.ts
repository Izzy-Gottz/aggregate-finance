// What an unexpected error may put in the server log. Never the error object itself: printing it lists every property
// a library hung on it (a provider's response body, a Postgres row in `detail`, request headers), and those can carry
// amounts, merchant names, emails or tokens. Only the name, a scrubbed message (capped), the safe identifiers our own
// errors carry, the stack frames, and the same for up to two causes.

const MAX_MESSAGE = 300

/** Key-, token- and personal-looking text out of a message: keys and tokens redacted, emails and long numbers masked. */
export function scrubLogText(s: string): string {
  return s
    .replace(/\b(sk|rk|pk|whsec)_(test_|live_)?[A-Za-z0-9*_]+/g, '$1_***')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[token]')
    .replace(/\b(access|refresh|id)[_-]?token["']?\s*[:=]\s*["']?[^\s"',}]+/gi, '$1_token=[redacted]')
    .replace(/\b(postgres(?:ql)?|https?):\/\/[^\s@/]+@/gi, '$1://[redacted]@')
    .replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1•••@$2')
    .replace(/\d{9,}/g, (d) => `[${d.length} digits]`)
}

export interface LoggedError {
  name: string
  message: string
  code?: string
  kind?: string
  provider?: string
  status?: number
  requestId?: string
  stack?: string[]
  cause?: LoggedError
}

/** The log-safe form of anything thrown. */
export function errorForLog(err: unknown, depth = 0): LoggedError {
  if (!(err instanceof Error)) return { name: typeof err, message: scrubLogText(String(err)).slice(0, MAX_MESSAGE) }
  const e = err as Error & Record<string, unknown>
  const pick = (k: string) => (typeof e[k] === 'string' ? scrubLogText(e[k] as string).slice(0, 80) : undefined)
  const out: LoggedError = { name: err.name, message: scrubLogText(err.message).slice(0, MAX_MESSAGE) }
  for (const k of ['code', 'kind', 'provider', 'requestId'] as const) {
    const v = pick(k)
    if (v) out[k] = v
  }
  if (typeof e.status === 'number') out.status = e.status
  // Frames only: the stack's first line repeats the unscrubbed message.
  const frames = (err.stack ?? '').split('\n').filter((l) => /^\s+at /.test(l)).slice(0, 12).map((l) => scrubLogText(l.trim()))
  if (frames.length) out.stack = frames
  if (depth < 2 && err.cause !== undefined) out.cause = errorForLog(err.cause, depth + 1)
  return out
}
