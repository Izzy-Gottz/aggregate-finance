// Records the Shopify App Store screencast: install → grant → the app in Shopify admin → connect to Aggregate →
// the store's data in Aggregate → back in admin, synced → uninstall. No audio; captions are drawn on the page.
//
// One-time setup (in a scratch folder, not the repo; nothing system-wide):
//   mkdir -p ~/agfn-screencast && cd ~/agfn-screencast && npm i playwright@1.49.1 && npx playwright install chromium
//   node <repo>/scripts/screencast/shopify.mjs --login     # a plain (not automated) Chromium opens on the same profile:
//                                                          # sign in to Shopify admin and to Aggregate (as the store's
//                                                          # staff email), then quit it. Shopify refuses sign-in in an
//                                                          # automation-controlled browser, so the sign-in happens outside it.
// Record (any time after, from ~/agfn-screencast):
//   node <repo>/scripts/screencast/shopify.mjs             # writes ~/agfn-screencast/out/shopify-screencast.webm
// YouTube accepts .webm as is; for MP4: ffmpeg -i out/shopify-screencast.webm -c:v libx264 -pix_fmt yuv420p out/shopify-screencast.mp4
//
// The app must not be installed on the store when recording starts (the script uninstalls it at the end).

import { createRequire } from 'node:module'
import { mkdirSync, readdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

const STORE = process.env.SHOPIFY_STORE ?? 'aggregate-test-store'
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID ?? '6c383b924db0af4d314629ce3dcc66eb' // public client id of the "Aggregate" app
const PROFILE = join(process.cwd(), 'profile')
const OUT = join(process.cwd(), 'out')
const SIZE = { width: 1280, height: 720 } // must fit the screen, or the page renders shorter than the video
const pw = await import(createRequire(join(process.cwd(), '/')).resolve('playwright'))
const { chromium } = pw.default ?? pw // CommonJS: the exports arrive as `default`

const login = process.argv.includes('--login')
mkdirSync(OUT, { recursive: true })

if (login) {
  // A normal browser on the recording profile: no automation, same mock keychain Playwright uses, so the cookies carry
  // over to the recording.
  const { execFileSync } = await import('node:child_process')
  const app = join(dirname(chromium.executablePath()), '..', '..')
  execFileSync('open', ['-na', app, '--args', `--user-data-dir=${PROFILE}`, '--use-mock-keychain', '--no-first-run', '--no-default-browser-check', `https://admin.shopify.com/store/${STORE}`, 'https://app.aggregate.finance'])
  console.log('Sign in to Shopify admin and to Aggregate in the Chromium window, then quit it (Cmd+Q).')
  process.exit(0)
}

const resetOnly = process.argv.includes('--uninstall') // uninstall from the test store only (no recording), to start clean
const context = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: SIZE, ...(resetOnly ? {} : { recordVideo: { dir: OUT, size: SIZE } }) })

const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function caption(page, text) {
  await page.evaluate((t) => {
    let el = document.getElementById('agfn-caption')
    if (!el) {
      el = document.createElement('div')
      el.id = 'agfn-caption'
      el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;max-width:80%;padding:12px 20px;border-radius:10px;background:rgba(17,17,17,.88);color:#fff;font:500 20px/1.35 -apple-system,system-ui,sans-serif;text-align:center;pointer-events:none'
      document.body.appendChild(el)
    }
    el.textContent = t
  }, text).catch(() => undefined)
  await pause(3800)
}
const appFrame = (page) => page.frameLocator('iframe[name="app-iframe"], iframe[title="Aggregate"]').first()

const admin = context.pages()[0] ?? (await context.newPage())

/** Shopify admin › Settings › Apps › Aggregate › Uninstall (with a reason, which Shopify requires). */
async function uninstall(page, withCaption) {
  await page.goto(`https://admin.shopify.com/store/${STORE}/settings/apps`)
  // The row's "…" button has no accessible name: find it by position, along the app's row.
  const findAndClick = () => page.evaluate(() => {
    const label = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent?.trim() === 'Aggregate').map((e) => e.getBoundingClientRect()).find((r) => r.x > 400)
    if (!label) return false
    const y = label.y + label.height / 2
    for (let x = window.innerWidth - 20; x > label.x + 100; x -= 4) {
      const b = document.elementFromPoint(x, y)?.closest('button')
      if (b) { b.click(); return true }
    }
    return false
  })
  let clicked = false
  for (let i = 0; i < 30 && !clicked; i++) {
    clicked = await findAndClick().catch(() => false)
    if (!clicked) await pause(1000) // the settings sheet draws its list a moment after it opens
  }
  if (!clicked) throw new Error('the Aggregate row is not on the Apps page (not installed?)')
  await page.getByText('Uninstall', { exact: true }).click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'Uninstall Aggregate?' })
  await dialog.getByText('Select all that apply').click()
  await page.getByText('Testing multiple apps').click()
  // Close the reason list by clicking the dialog's own text (Escape would close the whole dialog).
  await dialog.getByText('You’ll no longer be able to use the app', { exact: false }).click()
  if (withCaption) await caption(page, 'Uninstalling ends Aggregate’s access immediately; Shopify tells Aggregate, and the store is disconnected')
  await dialog.getByRole('button', { name: 'Uninstall', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: 30_000 })
}

if (resetOnly) {
  // A connection left from an earlier take: disconnect it inside the app first, so the recording starts "not connected".
  await admin.goto(`https://admin.shopify.com/store/${STORE}/apps/aggregate`).catch(() => undefined)
  const frame = appFrame(admin)
  if (await frame.getByRole('button', { name: 'Disconnect' }).first().isVisible({ timeout: 30_000 }).catch(() => false)) {
    await frame.locator('#disconnect').click()
    await frame.locator('#yes').click()
    await frame.getByText('isn’t connected to Aggregate yet').waitFor({ timeout: 30_000 }).catch(() => undefined)
    console.log('disconnected the leftover connection')
  }
  await uninstall(admin, false).catch(async (e) => {
    await admin.screenshot({ path: join(OUT, 'uninstall-failed.png') }).catch(() => undefined)
    console.log('nothing to uninstall or it failed:', e.message.split('\n').slice(0, 3).join(' | '))
  })
  await context.close()
  process.exit(0)
}

// 1. Install from the app's install link; Shopify shows what the app can see.
await admin.goto(`https://admin.shopify.com/store/${STORE}/oauth/install?client_id=${CLIENT_ID}`)
await admin.waitForURL(/\/app\/grant/, { timeout: 60_000 })
await caption(admin, 'Installing Aggregate: read-only access to the store and its Shopify Payments payouts')
await admin.getByRole('button', { name: 'Install' }).click()

// 2. The app opens inside Shopify admin straight after install.
await admin.waitForURL(/\/apps\/aggregate/, { timeout: 60_000 })
await appFrame(admin).getByText('isn’t connected to Aggregate yet').waitFor({ timeout: 60_000 })
await caption(admin, 'Aggregate opens in Shopify admin. The store isn’t connected yet')

// 3. Connect: the link signs in to Aggregate (same email as the store's staff account) and attaches the store. It
// opens a new tab for merchants; here it's followed in the same tab so the recording is one video.
const connectUrl = await appFrame(admin).getByRole('link', { name: 'Connect to Aggregate' }).getAttribute('href')
await caption(admin, 'Connect to Aggregate: the sign-in opens with your Shopify email filled in')
await admin.goto(connectUrl)
await admin.waitForURL(/app\.aggregate\.finance\/#\//, { timeout: 60_000 })
// The new connection's drawer opens; give it time to load, and close it if it's still loading.
await admin.getByText('Loading…').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => admin.keyboard.press('Escape'))
await pause(1500)
await caption(admin, 'Connected: the store’s payouts, fees and refunds now sync into Aggregate')
await caption(admin, 'They sit next to the merchant’s bank, cards and books, ready for their AI assistant to read')
await admin.keyboard.press('Escape').catch(() => undefined)
await pause(1500)
await caption(admin, 'Every number in one place: cash by company, and what changed')

// 4. Back in Shopify admin: the store shows as connected and synced.
await admin.goto(`https://admin.shopify.com/store/${STORE}/apps/aggregate`)
await appFrame(admin).getByText('sync to Aggregate (read-only)').waitFor({ timeout: 60_000 })
await caption(admin, 'Back in Shopify admin: connected and synced, with the store’s recent payouts right here')
await appFrame(admin).getByText(/Recent payouts|No payouts yet/).first().waitFor({ timeout: 30_000 }).catch(() => undefined)
await caption(admin, 'Each payout’s gross, fees, refunds and net, plus the next payout. “Disconnect” stops syncing at any time')

// 5. Uninstall: access ends at once.
await uninstall(admin, true)
await pause(3000)

await context.close()
// One tab, one video.
const video = readdirSync(OUT).filter((f) => f.endsWith('.webm') && f !== 'shopify-screencast.webm').map((f) => join(OUT, f)).sort().at(-1)
if (video) renameSync(video, join(OUT, 'shopify-screencast.webm'))
console.log(`Saved ${join(OUT, 'shopify-screencast.webm')}`)
