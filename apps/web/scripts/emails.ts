// Renders every email Aggregate sends to docs/screens/emails/ for review: the HTML, the plain-text part, and light/dark
// screenshots at desktop and phone width. `npm run screens:emails -w @agfn/web`. Made-up names only.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { sampleEmails } from '../../../packages/auth/src/email.ts'

const run = promisify(execFile)
const out = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/screens/emails')
const CHROME = process.env.CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)

await mkdir(out, { recursive: true })
const done: string[] = []
for (const [name, e] of Object.entries(sampleEmails())) {
  const html = join(out, `${name}.html`)
  await writeFile(html, e.html)
  await writeFile(join(out, `${name}.txt`), `Subject: ${e.subject}\n\n${e.text}`)
  done.push(`${name}.html`, `${name}.txt`)
  if (!CHROME) continue
  for (const [suffix, width, dark] of [['', 1000, false], ['-dark', 1000, true], ['-phone', 390, false]] as const) {
    const file = join(out, `${name}${suffix}.png`)
    // Chrome won't lay out narrower than ~500px headless, so the phone shot is a 390px-wide window onto a scaled page.
    await run(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--force-device-scale-factor=2',
      `--window-size=${Math.max(width, 500)},900`, ...(dark ? ['--force-dark-mode', '--blink-settings=preferredColorScheme=0'] : ['--blink-settings=preferredColorScheme=1']),
      `--screenshot=${file}`, pathToFileURL(html).href,
    ], { timeout: 60_000 }).catch((x: { stderr?: string }) => {
      if (!String(x.stderr ?? '').includes('bytes written to file')) throw x
    })
    done.push(`${name}${suffix}.png`)
  }
}
console.log(done.map((f) => `docs/screens/emails/${f}`).join('\n'))
