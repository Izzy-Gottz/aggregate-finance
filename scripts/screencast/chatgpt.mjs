// Records the ChatGPT review demo (OpenAI plugin submission: review.demo_recording_url): the Aggregate connector in a
// ChatGPT chat, running the 5 positive and 3 negative test cases from openai-plugin/plugin.json against the reviewer
// demo account. No audio; captions are drawn on the page.
//
// One-time setup (in a scratch folder, not the repo; nothing system-wide):
//   mkdir -p ~/agfn-screencast && cd ~/agfn-screencast && npm i playwright@1.49.1 && npx playwright install chromium
//   node <repo>/scripts/screencast/chatgpt.mjs --login      # a plain (not automated) Chromium opens on the profile:
//     1. sign in to chatgpt.com;
//     2. add the connector: Settings → Apps (Apps & Connectors) → Advanced settings → turn on Developer mode, then
//        Create (or "+"): name Aggregate, MCP server URL https://app.aggregate.finance/mcp, authentication OAuth;
//     3. Connect: in the Aggregate window choose "Reviewer? Use an access code", paste (the code is already on the
//        clipboard, read from OPENAI_REVIEW_CODE in ~/meridn/.reviewer-links; never printed), then Allow;
//     then quit Chromium (Cmd+Q). ChatGPT may refuse sign-in in an automation-controlled browser, hence this step.
// Record (any time after, from ~/agfn-screencast):
//   node <repo>/scripts/screencast/chatgpt.mjs              # writes ~/agfn-screencast/out/chatgpt-demo.webm
// Upload it somewhere a reviewer can open without signing in (an unlisted YouTube video is fine) and put that URL in
// openai-plugin/plugin.json → review.demo_recording_url.
//
// ChatGPT's page changes often: if a selector below stops matching, the run stops with the step's name. The prompts and
// captions come from plugin.json, so the video always shows exactly the submitted test cases.

import { createRequire } from 'node:module'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROFILE = join(process.cwd(), 'profile-chatgpt')
const OUT = join(process.cwd(), 'out')
const SIZE = { width: 1440, height: 900 }
const plugin = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../openai-plugin/plugin.json'), 'utf8'))
const cases = plugin.extensions['com.openai'].review.test_cases
const pw = await import(createRequire(join(process.cwd(), '/')).resolve('playwright'))
const { chromium } = pw.default ?? pw

mkdirSync(OUT, { recursive: true })
if (process.argv.includes('--login')) {
  const { execFileSync } = await import('node:child_process')
  const app = join(dirname(chromium.executablePath()), '..', '..')
  // The reviewer access code goes straight to the clipboard, never to the screen or the terminal.
  const links = join(process.env.HOME ?? '', 'meridn', '.reviewer-links')
  const code = (() => { try { return readFileSync(links, 'utf8').match(/^OPENAI_REVIEW_CODE=(.+)$/m)?.[1]?.trim() } catch { return undefined } })()
  if (code) execFileSync('pbcopy', { input: code })
  else console.log(`No OPENAI_REVIEW_CODE in ${links}: paste the reviewer access code by hand in step 3.`)
  execFileSync('open', ['-na', app, '--args', `--user-data-dir=${PROFILE}`, '--use-mock-keychain', '--no-first-run', '--no-default-browser-check', 'https://chatgpt.com'])
  console.log('Sign in to ChatGPT, add and connect the Aggregate connector (see the top of this file), then quit Chromium (Cmd+Q).')
  process.exit(0)
}

const context = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: SIZE, recordVideo: { dir: OUT, size: SIZE } })
const page = context.pages()[0] ?? (await context.newPage())
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function caption(text, ms = 3200) {
  await page.evaluate((t) => {
    let el = document.getElementById('agfn-caption')
    if (!el) {
      el = document.createElement('div')
      el.id = 'agfn-caption'
      el.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483647;max-width:80%;padding:12px 20px;border-radius:10px;background:rgba(17,17,17,.88);color:#fff;font:500 19px/1.35 -apple-system,system-ui,sans-serif;text-align:center;pointer-events:none'
      document.body.appendChild(el)
    }
    el.textContent = t
  }, text).catch(() => undefined)
  await pause(ms)
}
async function step(name, fn) {
  try {
    return await fn()
  } catch (e) {
    console.error(`Stopped at "${name}": ${e instanceof Error ? e.message : e}`)
    await context.close()
    process.exit(1)
  }
}

/** A new chat with the Aggregate connector on, then one prompt; waits until ChatGPT has finished answering. */
async function ask(prompt) {
  await step('new chat', () => page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' }))
  const box = page.locator('#prompt-textarea, [contenteditable="true"][data-virtualkeyboard="true"], div[contenteditable="true"]').first()
  await step('composer', () => box.waitFor({ timeout: 60_000 }))
  // Name the app so ChatGPT routes the question to it (and the viewer sees which app answers).
  await step('type prompt', async () => {
    await box.click()
    await page.keyboard.type(`Using Aggregate: ${prompt}`, { delay: 18 })
  })
  await pause(600)
  await page.keyboard.press('Enter')
  // ChatGPT may ask to confirm a tool call ("Allow"/"Confirm"); accept it on camera.
  const confirm = page.getByRole('button', { name: /^(Allow|Confirm|Always allow)$/ }).first()
  const stop = page.locator('[data-testid="stop-button"], button[aria-label="Stop streaming"]').first()
  const started = Date.now()
  await pause(2500)
  while (Date.now() - started < 180_000) {
    if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => undefined)
    if (!(await stop.isVisible().catch(() => false))) break
    await pause(1000)
  }
  await pause(1500)
  // Scroll the answer into view and hold it long enough to read.
  await page.keyboard.press('End').catch(() => undefined)
  await pause(5000)
}

await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' })
await caption('Aggregate in ChatGPT: every company’s money in one ledger. Reviewer demo account, made-up companies.', 4500)
await caption('Aggregate reads and records. It never moves money or contacts anyone.', 3500)

for (const [i, c] of cases.positive.entries()) {
  await ask(c.prompt)
  await caption(`Test ${i + 1} of 5: ${c.description}. Expected: ${c.expected_behavior}`, 6000)
}
for (const [i, c] of cases.negative.entries()) {
  await ask(c.prompt)
  await caption(`Should not act ${i + 1} of 3: ${c.description}`, 6000)
}
await caption('Every change is labeled with the AI that made it, can be undone for 30 days, and shows in the Activity list in Aggregate.', 4500)

// This page's own recording (out/ also holds other screencasts' videos).
const video = page.video()
await context.close()
await video?.saveAs(join(OUT, 'chatgpt-demo.webm'))
await video?.delete()
console.log(`Wrote ${join(OUT, 'chatgpt-demo.webm')}`)
