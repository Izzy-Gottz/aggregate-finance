// Build step for the aggregate.finance Worker (wrangler runs it before every deploy, see ../site/wrangler.jsonc).
// Writes sizes.json: byte size of every video under apps/site, keyed by URL path. The Range script needs the total
// size for Content-Range, and the static-assets binding does not send Content-Length.
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const site = join(here, '..', 'site')
const sizes = {}
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.vercel' || name === '.wrangler') continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p)
    else if (name.endsWith('.mp4')) sizes['/' + relative(site, p).split(sep).join('/')] = st.size
  }
}
walk(site)
writeFileSync(join(here, 'sizes.json'), JSON.stringify(sizes, null, 1) + '\n')
console.log(`sizes.json: ${Object.keys(sizes).length} videos`)
