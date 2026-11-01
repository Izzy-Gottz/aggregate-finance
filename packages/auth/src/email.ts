// Every email Aggregate sends, built in one place: a plain subject, a real plain-text part, and a light, minimal HTML
// part in the app's look (serif heading, one black button). No images, no tracking pixels, no link wrapping: every
// link is the real URL. Dark mode: Apple Mail follows prefers-color-scheme; Gmail and Outlook invert a simple light
// layout cleanly, so nothing here depends on a background image or a coloured block.

export interface Email {
  subject: string
  text: string
  html: string
}

interface Content {
  subject: string
  /** Shown in the inbox list next to the subject (hidden in the body). */
  preheader: string
  heading: string
  paragraphs: string[]
  action?: { label: string; url: string }
  /** A one-time code under the button, for when the link opens in another browser (shown as "123 456"). */
  code?: { label: string; value: string }
  /** Quieter lines under the button (grey). */
  notes?: string[]
  /** Why you got this / how to stop it. */
  footer: string
  /** "Aggregate", or the server's AGFN_APP_NAME. */
  app: string
}

/** "123456" → "123 456": easier to read and type. */
const spaced = (code: string) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code)

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const SANS = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`
const SERIF = `Newsreader,Georgia,'Times New Roman',serif`
const INK = '#1F1B1C'
const GREY = '#6B6766'
const PAGE = '#FAF9F7'
const RULE = '#E7E4E0'

function text(c: Content): string {
  const parts = [c.heading, ...c.paragraphs]
  if (c.action) parts.push(`${c.action.label}: ${c.action.url}`)
  if (c.code) parts.push(`${c.code.label}\n\n${spaced(c.code.value)}`)
  if (c.notes?.length) parts.push(...c.notes)
  parts.push(`—\n${c.footer}`)
  return parts.join('\n\n') + '\n'
}

function html(c: Content): string {
  const row = (inner: string, style: string, cls = 'ink') => `<tr><td class="${cls}" style="${style}">${inner}</td></tr>`
  const body = (s: string) => row(esc(s), `font:400 15px/24px ${SANS};color:${INK};padding:0 0 14px`)
  const note = (s: string) => row(esc(s), `font:400 13px/20px ${SANS};color:${GREY};padding:0 0 8px`, 'grey')
  const button = c.action
    ? `<tr><td style="padding:10px 0 26px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="btn" bgcolor="${INK}" style="border-radius:6px;background:${INK}"><a class="btn-a" href="${esc(c.action.url)}" style="display:inline-block;padding:12px 22px;font:500 15px/20px ${SANS};color:#FFFFFF;text-decoration:none;border-radius:6px">${esc(c.action.label)}</a></td></tr></table></td></tr>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(c.subject)}</title>
<style>
:root { color-scheme: light dark; supported-color-schemes: light dark; }
body { margin: 0; padding: 0; background: ${PAGE}; }
a { color: ${INK}; }
@media (prefers-color-scheme: dark) {
  body, .bg { background: #121110 !important; }
  .ink, .ink a { color: #EDEBE8 !important; }
  .grey, .grey a { color: #9C9895 !important; }
  .btn { background: #EDEBE8 !important; }
  .btn-a { color: #121110 !important; }
  .rule { border-color: #2A2826 !important; }
}
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:${PAGE}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(c.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background:${PAGE}">
<tr><td align="center" style="padding:40px 20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px">
${row(esc(c.app), `font:400 20px/28px ${SERIF};color:${INK};padding:0 0 36px`)}
${row(esc(c.heading), `font:400 26px/34px ${SERIF};color:${INK};padding:0 0 18px`)}
${c.paragraphs.map(body).join('\n')}
${button}${c.code ? '\n' + row(esc(c.code.label), `font:400 13px/20px ${SANS};color:${GREY};padding:0 0 6px`, 'grey') + '\n' + row(esc(spaced(c.code.value)), `font:500 28px/36px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:4px;color:${INK};padding:0 0 26px`) : ''}
${(c.notes ?? []).map(note).join('\n')}
${row(esc(c.footer), `font:400 13px/20px ${SANS};color:${GREY};padding:20px 0 0;border-top:1px solid ${RULE}`, 'grey rule')}
</table>
</td></tr>
</table>
</body>
</html>
`
}

function render(c: Content): Email {
  return { subject: c.subject, text: text(c), html: html(c) }
}

const base = (u: string) => u.replace(/\/+$/, '')

/** Magic sign-in link. Says it expires, and that we never ask for a password. */
export function signInEmail(o: { url: string; code?: string; app?: string; minutes?: number }): Email {
  const app = o.app ?? 'Aggregate'
  const m = o.minutes ?? 10
  return render({
    app,
    subject: `Your ${app} sign-in link (expires in ${m} minutes)`,
    preheader: `It works once and expires in ${m} minutes.`,
    heading: `Sign in to ${app}`,
    paragraphs: [`This link signs you in. It works once and expires in ${m} minutes.`],
    action: { label: 'Sign in', url: o.url },
    ...(o.code ? { code: { label: 'Opening this somewhere else? Type this code on the page where you asked to sign in:', value: o.code } } : {}),
    notes: [`${app} never asks for your password, by email or anywhere else.${o.code ? ' Never read this code to anyone or type it on a page you didn’t open yourself.' : ''}`, `If you didn’t ask for this, ignore this email. No one can sign in without the ${o.code ? 'link or the code' : 'link'}.`],
    footer: 'You get this because someone entered this email address to sign in.',
  })
}

/** The one-time "it's you" link: the fallback when a passkey isn't on this device (apps/server recheck.ts). */
export function recheckEmail(o: { url: string; code?: string; app?: string; minutes?: number }): Email {
  const app = o.app ?? 'Aggregate'
  const m = o.minutes ?? 10
  return render({
    app,
    subject: `Confirm it’s you in ${app} (expires in ${m} minutes)`,
    preheader: `Confirms a sensitive action. It works once and expires in ${m} minutes.`,
    heading: 'Confirm it’s you',
    paragraphs: [`You asked to confirm it’s you by email instead of a passkey, to finish something sensitive (connecting an account, giving an AI access or deleting data). This link works once and expires in ${m} minutes. Open it on any device, then go back and try again.`],
    action: { label: 'Confirm it’s me', url: o.url },
    ...(o.code ? { code: { label: 'Or type this code where you were asked to confirm:', value: o.code } } : {}),
    notes: ['If you didn’t ask for this, don’t open the link or use the code, and change your email password: someone signed in to Aggregate as you is trying to confirm a sensitive action.'],
    footer: 'You get this because someone signed in to your account asked to confirm it’s you by email.',
  })
}

/** Invitation to a workspace (the link signs them in and joins). */
export function inviteEmail(o: { url: string; inviterName: string; workspaceName: string; baseUrl: string; app?: string; minutes?: number }): Email {
  const app = o.app ?? 'Aggregate'
  const m = o.minutes ?? 10
  return render({
    app,
    subject: `${o.inviterName} invited you to ${o.workspaceName} on ${app}`,
    preheader: `Join ${o.workspaceName}. The link expires in ${m} minutes.`,
    heading: `${o.inviterName} invited you to ${o.workspaceName}`,
    paragraphs: [`${app} keeps a company’s money in one place, ready for any AI. It only reads; it can’t move money.`],
    action: { label: `Join ${o.workspaceName}`, url: o.url },
    notes: [`The link works once and expires in ${m} minutes. If it expires, sign in at ${base(o.baseUrl)} with this email address.`, 'If you weren’t expecting this, ignore this email.'],
    footer: `${o.inviterName} entered this email address in ${app}.`,
  })
}

/** The Monday note: the digest's own subject and up to five lines. */
export function mondayEmail(o: { subject: string; lines: string[]; baseUrl: string; app?: string }): Email {
  const app = o.app ?? 'Aggregate'
  const lines = o.lines.slice(0, 5)
  return render({
    app,
    subject: o.subject,
    preheader: lines[0] ?? '',
    heading: o.subject.split(' · ')[0] ?? o.subject,
    paragraphs: lines,
    action: { label: `Open ${app}`, url: base(o.baseUrl) + '/' },
    footer: 'Turn the Monday note off in Preferences.',
  })
}

/** A connection stopped updating and needs a fresh sign-in at the provider. */
export function reconnectEmail(o: { connectionName: string; connectionId: string; baseUrl: string; app?: string }): Email {
  const app = o.app ?? 'Aggregate'
  return render({
    app,
    subject: `${o.connectionName} needs you to sign in again`,
    preheader: 'Everything else is still current.',
    heading: `${o.connectionName} needs you to sign in again`,
    paragraphs: [`${o.connectionName} stopped updating and needs you to sign in again.`, 'Your other numbers are still current; this one is paused until you reconnect.'],
    action: { label: 'Reconnect', url: `${base(o.baseUrl)}/#/?d=connection:${encodeURIComponent(o.connectionId)}` },
    footer: 'You get this because you manage this workspace.',
  })
}

/** Sent before a workspace is deleted to each other member whose Personal connections there go with it. */
export function workspaceDeletingEmail(o: { workspaceName: string; ownerName: string; connections: string[]; app?: string }): Email {
  const app = o.app ?? 'Aggregate'
  const list = o.connections.length <= 1 ? (o.connections[0] ?? '') : `${o.connections.slice(0, -1).join(', ')} and ${o.connections.at(-1)}`
  return render({
    app,
    subject: `${o.workspaceName} is being deleted`,
    preheader: 'Your Personal connections there go with it.',
    heading: `${o.workspaceName} is being deleted`,
    paragraphs: [
      `${o.ownerName} is deleting the workspace ${o.workspaceName} in ${app}.`,
      `Your Personal connections there (${list}) will be disconnected and everything in your Personal space there deleted. Your other workspaces aren’t affected.`,
      'To keep tracking those accounts, connect them again in a workspace of your own.',
    ],
    footer: `You get this because you belong to ${o.workspaceName}.`,
  })
}

/** An AI asked for something its access doesn't include (once per AI per day). */
export function refusedEmail(o: { client: string; what: string[]; grantId: string; baseUrl: string; app?: string }): Email {
  const app = o.app ?? 'Aggregate'
  const list = o.what.slice(0, 3).join(', ')
  return render({
    app,
    subject: `${o.client} asked for something it can’t see`,
    preheader: 'Nothing changed.',
    heading: `${o.client} asked for something it can’t see`,
    paragraphs: [`${o.client} tried to ${list} and was refused, because its access doesn’t include that.`, 'Nothing changed. To allow it, edit what it can see.'],
    action: { label: `Edit ${o.client}’s access`, url: `${base(o.baseUrl)}/#/?d=ai:${encodeURIComponent(o.grantId)}` },
    footer: 'Turn these off in Preferences.',
  })
}

/** Service notice after 90 days without use (connections keep syncing until someone acts). */
export function inactivityEmail(o: { baseUrl: string; app?: string }): Email {
  const app = o.app ?? 'Aggregate'
  return render({
    app,
    subject: `Your ${app} workspace hasn’t been used in 90 days`,
    preheader: 'Bank connections are still syncing.',
    heading: 'Your workspace hasn’t been used in 90 days',
    paragraphs: ['Bank connections are still syncing. If you don’t need them any more, you can disconnect them or delete the workspace.'],
    action: { label: 'Open Preferences', url: `${base(o.baseUrl)}/#/preferences` },
    footer: 'This is a service notice about your account.',
  })
}

/** One of each, with made-up names, for previews and snapshot tests. */
export function sampleEmails(baseUrl = 'https://app.aggregate.finance'): Record<string, Email> {
  return {
    'sign-in': signInEmail({ url: `${baseUrl}/api/auth/magic-link/verify?token=SAMPLE` }),
    invite: inviteEmail({ url: `${baseUrl}/api/auth/magic-link/verify?token=SAMPLE`, inviterName: 'Dana Reyes', workspaceName: 'Northwind Labs', baseUrl }),
    monday: mondayEmail({
      subject: 'Your week in money · Oct 12',
      lines: ['Cash: $753,560 across 3 companies, up $12,400.', 'Runway: 18 months at Northwind Labs.', 'Overdue: 2 invoices, $8,250.', 'Coming up: payroll Friday, $41,300.', '2 things wait in Review.'],
      baseUrl,
    }),
    reconnect: reconnectEmail({ connectionName: 'Chase', connectionId: 'conn_sample', baseUrl }),
    refused: refusedEmail({ client: 'Claude', what: ['record payment'], grantId: 'grant_sample', baseUrl }),
    inactivity: inactivityEmail({ baseUrl }),
  }
}
