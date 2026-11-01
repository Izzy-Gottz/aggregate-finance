// Connect your AI: one list of assistants, each with the exact steps from its guide (docs/guides/connect-*.md, 23's)
// and a link to it. Where the guide says the hosted link, the app shows this server's own link with a copy button.
// Keep the words identical to the guides: assistants.test.ts checks every step against them.
import { useState } from 'preact/hooks'
import { CopyButton } from '../ui/components.ts'
import { html } from '../ui/html.ts'

/** `agfn` is published to npm on launch day (launch-day.md step 8); until then the setup command says so. */
export const AGFN_ON_NPM = false

/** A step's words: `{url}` is this server's MCP link, `{cursor}` its Cursor install link, `[text](href)` a link. */
type Step = string
export interface Assistant {
  key: string
  name: string
  line: string
  /** The guide this follows (docs/guides/<guide>.md, served at /docs/guides/<guide>). */
  guide: string
  steps: Step[]
  /** A command to copy (with `{url}`), shown after the steps. */
  commands?: Array<{ label: string; text: string; after?: string }>
  note?: string
  /** A direct link to where the steps start (only where the app documents a stable URL). */
  open?: { label: string; href: string }
  /** The note is the app's own words, not the guide's. */
  own?: boolean
}

export const ASSISTANTS: Assistant[] = [
  {
    key: 'claude',
    name: 'Claude',
    line: 'Web and desktop, then iPhone and Android',
    guide: 'connect-claude',
    // Claude's help center links this page directly ("Get started with custom connectors using remote MCP", 2026-10-12).
    open: { label: 'Open Claude ↗', href: 'https://claude.ai/customize/connectors' },
    steps: [
      'In Claude, open Customize → Connectors (in some accounts still Settings → Connectors), choose Add, then Add custom connector.',
      'Name: Aggregate. URL: {url}. Click Continue.',
      'Claude detects that Aggregate uses sign-in (Sign in now). Click Add, then Connect on the connector’s page.',
      'Sign in to Aggregate, choose what Claude can see, and confirm.',
    ],
    note: 'The Claude mobile apps use the connectors you’ve added on the web or desktop; you can’t add a new one from the phone. Add Aggregate once using the steps above, then open the Claude app on your phone and ask.',
  },
  {
    key: 'chatgpt',
    name: 'ChatGPT',
    line: 'A custom MCP server, on the web',
    guide: 'connect-chatgpt',
    steps: [
      'Open [ChatGPT Plugins](https://chatgpt.com/plugins), choose Add (top right), then Add custom MCP server.',
      'Name it “Aggregate” and add a short description.',
      'Under Connection, keep Server URL and paste {url}. Authentication: OAuth.',
      'Check I understand and want to continue, then select Create as a plugin.',
      'In the Connect Aggregate dialog, choose Connect, sign in to Aggregate and choose what ChatGPT can see.',
    ],
    note: 'In a ChatGPT Business or Enterprise workspace, an admin may need to allow custom MCP servers first.',
  },
  {
    key: 'grok',
    name: 'Grok',
    line: 'A custom connector on grok.com',
    guide: 'connect-grok',
    steps: ['Go to [grok.com/connectors](https://grok.com/connectors).', 'Choose New Connector, then Custom.', 'Paste {url} as the server URL.', 'Sign in to Aggregate when Grok asks, and choose what Grok can see.'],
    note: 'For Grok Business and Enterprise, a team admin provisions the connector first (xAI’s connector management console), then members can use it.',
  },
  {
    key: 'cursor',
    name: 'Cursor, VS Code',
    line: 'One click',
    guide: 'connect-cursor',
    steps: [
      '[Add Aggregate to Cursor]({cursor}) or [Add Aggregate to VS Code]({vscode}) (opens the app and asks you to confirm).',
      'The app then opens Aggregate’s sign-in page.',
    ],
  },
  {
    key: 'cli',
    name: 'Claude Code, Codex, Gemini CLI, Zed',
    line: 'From the terminal',
    guide: 'connect-cli',
    steps: [],
    commands: [
      { label: 'Claude Code', text: 'claude mcp add --transport http --scope user aggregate {url}', after: 'Then run /mcp in Claude Code to sign in.' },
      { label: `Codex CLI, Gemini CLI, Zed and the rest${AGFN_ON_NPM ? '' : ' · from launch day'}`, text: 'npx aggregate-finance setup', after: 'Codex CLI then needs one sign-in: codex mcp login aggregate. The others open Aggregate’s sign-in page the first time they use it.' },
    ],
  },
  {
    key: 'other',
    name: 'Other apps',
    line: 'Anything that supports custom MCP connectors',
    guide: 'connect-your-ai',
    steps: ['Add a remote (Streamable HTTP) server named aggregate with your Aggregate link.', 'Clients that support OAuth will open the sign-in page automatically (Codex CLI: run codex mcp login aggregate once).'],
    note: 'For a bot that can’t sign in, make a key below.',
    own: true,
  },
]

/** Cursor's install link for this server: base64 of {"url": …} (docs/guides/connect-cursor.md). */
export const cursorLink = (url: string) => `cursor://anysphere.cursor-deeplink/mcp/install?name=aggregate&config=${btoa(JSON.stringify({ url }))}`

/** VS Code's install link: vscode:mcp/install? and the server's entry as URL-encoded JSON (with its name). */
export const vscodeLink = (url: string) => `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'aggregate', type: 'http', url }))}`

const guideUrl = (g: string) => (g === 'connect-your-ai' ? '/docs/connect-your-ai' : `/docs/guides/${g}`)

function words(text: string, url: string) {
  return text.split(/(\{url\}|\[[^\]]+\]\([^)]+\))/).map((p) => {
    if (p === '{url}') return html`<code class="mono">${url}</code>`
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p)
    if (!link) return p
    const href = link[2] === '{cursor}' ? cursorLink(url) : link[2] === '{vscode}' ? vscodeLink(url) : link[2]!
    return html`<a class="link" href=${href} ...${href.startsWith('http') ? { target: '_blank', rel: 'noopener' } : {}}>${link[1]}</a>`
  })
}

/** The list: one row per assistant; opening one shows its steps. Claude starts open. */
export function AssistantList({ url, open: first = 'claude' }: { url: string; open?: string }) {
  const [open, setOpen] = useState<string | null>(first)
  return html`<ul class="assistants">
    ${ASSISTANTS.map((a) => {
      const on = open === a.key
      return html`<li>
        <button type="button" class="assistant" aria-expanded=${on ? 'true' : 'false'} onClick=${() => setOpen(on ? null : a.key)}>
          <span class="name">${a.name}</span><span class="line">${a.line}</span>
        </button>
        ${on
          ? html`<div class="assistant-steps">
              ${a.open ? html`<p class="meta" style="margin-top:8px"><a class="link" href=${a.open.href} target="_blank" rel="noopener">${a.open.label}</a></p>` : null}
              ${a.steps.length ? html`<ol class="steps">${a.steps.map((s) => html`<li>${words(s, url)}</li>`)}</ol>` : null}
              ${(a.commands ?? []).map(
                (c) => html`<p class="sub" style="margin-top:12px">${c.label}</p>
                  <div class="formrow" style="margin-top:4px;align-items:center"><code class="code" style="flex:1">${c.text.replace('{url}', url).split(' ').map((w, i) => html`${i ? ' ' : ''}<span class="nowrap">${w}</span>`)}</code><${CopyButton} text=${c.text.replace('{url}', url)} what="command" /></div>
                  ${c.after ? html`<p class="meta" style="margin-top:4px">${c.after}</p>` : null}`,
              )}
              ${a.note ? html`<p class="meta" style="margin-top:8px">${a.note}</p>` : null}
              <p class="meta" style="margin-top:8px"><a class="link" href=${guideUrl(a.guide)} target="_blank" rel="noopener">Full guide ↗</a></p>
            </div>`
          : null}
      </li>`
    })}
  </ul>`
}
