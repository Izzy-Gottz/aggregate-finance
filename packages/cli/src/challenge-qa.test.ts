// The challenge's operator commands refuse anywhere but the challenge deployment, and the reset asks for --confirm.
import { describe, expect, it } from 'vitest'
import { challengeCheckFlagCommand, challengeQaCommand, challengeResetCommand } from './challenge-qa.ts'
import type { Io } from './io.ts'

const io = (env: NodeJS.ProcessEnv): Io => ({ env, cwd: '/', out: () => {}, err: () => {} })
const ioIn = (env: NodeJS.ProcessEnv, input: string): Io => ({ ...io(env), readStdin: async () => input })
const noBoot = async () => {
  throw new Error('must not boot')
}

describe('challenge operator commands', () => {
  it('refuse without AGFN_CHALLENGE=1, before booting anything', async () => {
    await expect(challengeResetCommand(['--confirm', 'RESET'], io({}), noBoot)).rejects.toThrow(/only on the challenge/)
    await expect(challengeCheckFlagCommand(['FLAG-x'], io({}), noBoot)).rejects.toThrow(/only on the challenge/)
    await expect(challengeQaCommand(['--label', 'x'], io({}), noBoot)).rejects.toThrow(/only on the challenge/)
    // --web (which mints a browser session) is refused off the challenge too, before any boot.
    await expect(challengeQaCommand(['--label', 'x', '--web'], io({}), noBoot)).rejects.toThrow(/only on the challenge/)
  })
  it('the reset needs --confirm RESET', async () => {
    await expect(challengeResetCommand([], io({ AGFN_CHALLENGE: '1' }), noBoot)).rejects.toThrow(/--confirm RESET/)
  })

  describe('check-flag --stdin keeps the value off the command line', () => {
    it('--stdin with nothing piped in (no readStdin) is a usage error, not a boot', async () => {
      await expect(challengeCheckFlagCommand(['--stdin'], io({ AGFN_CHALLENGE: '1' }), noBoot)).rejects.toThrow(/needs the value piped in/)
    })
    it('--stdin plus a positional value is rejected (the value must only ever be on stdin)', async () => {
      await expect(challengeCheckFlagCommand(['--stdin', 'FLAG-x'], ioIn({ AGFN_CHALLENGE: '1' }, 'FLAG-x'), noBoot)).rejects.toThrow(/read from standard input/)
    })
    it('empty stdin is a usage error', async () => {
      await expect(challengeCheckFlagCommand(['--stdin'], ioIn({ AGFN_CHALLENGE: '1' }, '  \n'), noBoot)).rejects.toThrow(/no value on standard input/)
    })
    it('reads the piped value and never puts it in an error', async () => {
      // Env lacks AGFN_CHALLENGE, so it stops right after reading stdin — proving the value was read, and that the
      // error it raises carries the value nowhere.
      const err = await challengeCheckFlagCommand(['--stdin'], ioIn({}, 'FLAG-secret-value'), noBoot).then(
        () => new Error('should have thrown'),
        (e: Error) => e,
      )
      expect(err.message).toMatch(/only on the challenge/)
      expect(err.message).not.toContain('FLAG-secret-value')
    })
  })
})
