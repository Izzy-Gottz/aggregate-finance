// The shipped image is plain Alpine with pure-JavaScript dependencies. The Dockerfile drops pdfjs-dist's optional
// native canvas and fails the build on any *.node addon; keep both steps from being edited away.
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('the production dependency stage strips native addons and refuses any that remain', () => {
  const docker = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
  const stage = docker.slice(docker.indexOf('AS prod-deps'), docker.indexOf('FROM', docker.indexOf('AS prod-deps')))
  expect(stage).toContain("-path '*/node_modules/@napi-rs'")
  expect(stage).toMatch(/-name '\*\.node' -type f \| grep \.; then .*exit 1; fi/)
})

it('the image carries every public doc the server renders (a missing one shows "Not published yet")', async () => {
  const docker = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
  const { PUBLIC_DOCS } = await import('../apps/server/src/legal.ts')
  for (const { file } of Object.values(PUBLIC_DOCS)) expect(docker, file).toContain(`COPY docs/${file} ./docs/${file}`)
})

it('the image carries the key command the runtime runs as node', () => {
  const docker = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
  const runtime = docker.slice(docker.indexOf('AS runtime'))
  expect(runtime).toContain('COPY scripts/kms-master-key.mjs ./scripts/kms-master-key.mjs')
})
