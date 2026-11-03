import nodemailer from 'nodemailer'
import type { Mailer } from '@agfn/auth'

export function smtpMailer(url: string, from: string, log: (msg: string, fields: Record<string, unknown>) => void = (m, f) => console.warn(`[agfn] ${m}`, f)): Mailer {
  const transport = nodemailer.createTransport(url)
  return {
    async send(msg) {
      try {
        // Plain text plus HTML, nothing else: no tracking pixels, no rewritten links.
        await transport.sendMail({ from, to: msg.to, subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}) })
      } catch (err) {
        // A refused email (a sender the provider won't accept, a bad login) must show in the log, not vanish. The
        // provider's reply says why; the message itself (it may hold a sign-in link) and the recipient never do.
        const e = err as { responseCode?: number; code?: string; response?: string }
        log('email not sent', { code: e.responseCode ?? e.code ?? 'error', reason: String(e.response ?? (err instanceof Error ? err.message : '')).slice(0, 160) })
        throw err
      }
    },
  }
}

/**
 * Why sign-in emails would be refused before any is sent: with SMTP set but no MAIL_FROM, the sender is
 * no-reply@<this server's host>, which no mail provider accepts for localhost or an IP address.
 */
export function mailFromProblem(env: { SMTP_URL?: string; MAIL_FROM?: string }, baseUrl: string): string | null {
  if (!env.SMTP_URL || env.MAIL_FROM) return null
  const host = new URL(baseUrl).hostname
  if (host.includes('.') && !/^[\d.]+$/.test(host) && !host.endsWith('.localhost')) return null
  return `SMTP_URL is set but MAIL_FROM isn't, so emails would come from no-reply@${host}, which mail providers refuse. Set MAIL_FROM="Aggregate <no-reply@yourdomain.com>" on a domain your provider has verified; until then sign-in emails won't arrive.`
}

/**
 * Self-host without email set up: sign-in links are printed to the server console, which only the person running
 * the server can see. Never used when SMTP is configured.
 */
export function consoleMailer(log: (line: string) => void = (l) => process.stdout.write(l + '\n')): Mailer {
  return {
    async send(msg) {
      log(`\n[agfn] Email to ${msg.to}: ${msg.subject}\n${msg.text}\n`)
    },
  }
}

/**
 * Test addresses (any recipient under the reserved `.test` TLD, which can never receive mail) go to the console
 * instead of the real mailer, so smoke runs against a server with real email can still sign in. Real addresses are
 * untouched. Opt-in with AGFN_LOG_TEST_LINKS=1 (staging); never set in fly.production.toml.
 */
export function withTestAddressesLogged(real: Mailer, log: Mailer = consoleMailer()): Mailer {
  return {
    async send(msg) {
      const domain = msg.to.split('@').pop()?.toLowerCase() ?? ''
      if (domain === 'test' || domain.endsWith('.test')) return log.send(msg)
      return real.send(msg)
    },
  }
}

/**
 * AGFN_MAIL_ALLOW (comma list of exact addresses) holds all other mail: a test server can't reach real people or spend
 * the shared sending quota. Unset, nothing changes. Never set on live.
 */
export function withMailAllowList(real: Mailer, allow: string): Mailer {
  const listed = new Set(allow.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean))
  return {
    async send(msg) {
      if (listed.has(msg.to.trim().toLowerCase())) return real.send(msg)
      console.warn('[agfn] mail held by AGFN_MAIL_ALLOW')
    },
  }
}
