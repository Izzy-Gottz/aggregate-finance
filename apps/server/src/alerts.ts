/**
 * Operator alerts. Everything is logged to the console; when ALERT_WEBHOOK_URL is set, problems are also POSTed there
 * as `{ text }` (works with Slack and Discord incoming webhooks, ntfy, or any endpoint of your own), and when
 * ALERT_TELEGRAM_BOT_TOKEN and ALERT_TELEGRAM_CHAT_ID are set, sent to that Telegram chat. The same alert is
 * sent at most once per 10 minutes (per connector, job and workspace). Alerts never carry secrets or financial data: only the message and a few ids.
 */
export type AlertLevel = 'info' | 'warn' | 'error'
export type Alert = (level: AlertLevel, message: string, fields?: Record<string, unknown>) => void

const SAFE_FIELD = /^(connectionId|connector|workspaceId|job|kind|status|error|count|revoked|files|rows|connectionsRevoked)$/

export function createAlerter(opts: { webhookUrl?: string; telegram?: { botToken: string; chatId: string }; fetch?: typeof fetch; now?: () => number; label?: string } = {}): Alert & { flush(): Promise<void> } {
  const send = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const lastSent = new Map<string, number>()
  const inflight = new Set<Promise<unknown>>()
  const alert = ((level, message, fields = {}) => {
    console.warn(`[agfn] ${message}`, Object.keys(fields).length ? fields : '')
    if ((!opts.webhookUrl && !opts.telegram) || level === 'info') return
    const key = `${message}|${String(fields.connector ?? '')}|${String(fields.job ?? '')}|${String(fields.workspaceId ?? '')}`
    const t = now()
    if ((lastSent.get(key) ?? -Infinity) > t - 10 * 60_000) return
    lastSent.set(key, t)
    const safe = Object.entries(fields)
      .filter(([k]) => SAFE_FIELD.test(k))
      .map(([k, v]) => `${k}=${String(v).slice(0, 200)}`)
      .join(' ')
    const text = `${level === 'error' ? '🔴' : '🟠'} ${opts.label ?? 'Aggregate'}: ${message}${safe ? ` (${safe})` : ''}`
    const post = (url: string, body: unknown) => {
      // Failures are swallowed without a word: the Telegram URL carries the bot token, so it never reaches a log.
      const p = send(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
        .catch(() => undefined)
        .finally(() => inflight.delete(p))
      inflight.add(p)
    }
    if (opts.webhookUrl) post(opts.webhookUrl, { text, content: text })
    // Plain text (no parse_mode), so a message never fails on Markdown it happens to contain.
    if (opts.telegram) post(`https://api.telegram.org/bot${opts.telegram.botToken}/sendMessage`, { chat_id: opts.telegram.chatId, text })
  }) as Alert & { flush(): Promise<void> }
  alert.flush = async () => void (await Promise.all([...inflight]))
  return alert
}
