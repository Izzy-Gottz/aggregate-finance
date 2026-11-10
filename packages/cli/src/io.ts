// Everything a command touches from the outside world, so commands are testable without a real terminal.

export interface Io {
  env: NodeJS.ProcessEnv
  cwd: string
  out(line: string): void
  err(line: string): void
  /** One line typed by the person; absent when nobody is at a terminal (commands then need an explicit flag). */
  ask?(question: string): Promise<string>
  /** All of standard input, for a secret a command must not take on the command line; absent at a bare terminal. */
  readStdin?(): Promise<string>
}

export const processIo = (): Io => ({
  env: process.env,
  cwd: process.cwd(),
  out: (l) => process.stdout.write(l + '\n'),
  err: (l) => process.stderr.write(l + '\n'),
  ...(process.stdin.isTTY
    ? {
        ask: async (q: string) => {
          const { createInterface } = await import('node:readline/promises')
          const rl = createInterface({ input: process.stdin, output: process.stdout })
          try {
            return await rl.question(q)
          } finally {
            rl.close()
          }
        },
      }
    : {
        // Only when input is piped or redirected (not a bare terminal, where this would hang waiting for input).
        readStdin: async () => {
          process.stdin.setEncoding('utf8')
          let data = ''
          for await (const chunk of process.stdin) data += chunk
          return data
        },
      }),
})

/** A usage or input problem: printed without a stack trace, exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string | true>
}

/** `--name value`, `--name=value` and boolean `--flag`. Unknown flags are the command's problem. */
export function parseArgs(argv: string[], booleans: readonly string[] = []): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1))
      else {
        const name = a.slice(2)
        const next = argv[i + 1]
        if (booleans.includes(name) || next === undefined || next.startsWith('--')) flags.set(name, true)
        else {
          flags.set(name, next)
          i++
        }
      }
    } else positionals.push(a)
  }
  return { positionals, flags }
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name)
  if (v === true) throw new UsageError(`--${name} needs a value`)
  return v
}

export function rejectUnknown(args: ParsedArgs, allowed: readonly string[]): void {
  for (const k of args.flags.keys()) if (!allowed.includes(k)) throw new UsageError(`unknown option --${k}`)
}
