// FX rates: daily, deterministic, cached. Frankfurter (ECB reference rates) by default; fixed tables in tests.
import type { Currency, IsoDate } from '@agfn/contracts'
import { assertCurrency, decimalToString, divRound, parseDecimal } from './money.ts'
import type { LedgerStore, RateSource } from './store.ts'

export class RateUnavailableError extends Error {
  override name = 'RateUnavailableError'
}

const RATE_SCALE = 12

/** Invert a decimal rate, rounded to 12 places. */
export function invertRate(rate: string): string {
  const d = parseDecimal(rate)
  if (d.num === 0n) throw new RateUnavailableError('Cannot invert a zero rate')
  // 1 / (num / 10^scale) = 10^scale / num, expressed with RATE_SCALE places.
  const num = divRound(10n ** BigInt(d.scale + RATE_SCALE), d.num)
  return decimalToString({ num, scale: RATE_SCALE })
}

/** Multiply two decimal rates (cross rates through a pivot), rounded to 12 places. */
export function multiplyRates(a: string, b: string): string {
  const x = parseDecimal(a)
  const y = parseDecimal(b)
  const scale = x.scale + y.scale
  const num = scale > RATE_SCALE ? divRound(x.num * y.num, 10n ** BigInt(scale - RATE_SCALE)) : x.num * y.num
  return decimalToString({ num, scale: Math.min(scale, RATE_SCALE) })
}

export function previousDay(date: IsoDate, days = 1): IsoDate {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

/**
 * Fixed rate table: set(date, from, to, rate). Looks back up to 7 days for weekends and holidays,
 * inverts when only the opposite pair is known, and crosses through `pivot` (default EUR, like the ECB).
 */
export class MemoryRateSource implements RateSource {
  #rates = new Map<string, string>()
  #pivot: Currency

  constructor(pivot: Currency = 'EUR') {
    this.#pivot = pivot
  }

  set(date: IsoDate, from: Currency, to: Currency, rate: string | number): this {
    assertCurrency(from)
    assertCurrency(to)
    this.#rates.set(`${date}|${from}|${to}`, decimalToString(parseDecimal(rate)))
    return this
  }

  #direct(date: IsoDate, from: Currency, to: Currency): string | null {
    const r = this.#rates.get(`${date}|${from}|${to}`)
    if (r) return r
    const inv = this.#rates.get(`${date}|${to}|${from}`)
    return inv ? invertRate(inv) : null
  }

  async rate(date: IsoDate, from: Currency, to: Currency): Promise<string> {
    if (from === to) return '1'
    for (let back = 0; back <= 7; back++) {
      const d = previousDay(date, back)
      const direct = this.#direct(d, from, to)
      if (direct) return direct
      if (from !== this.#pivot && to !== this.#pivot) {
        const a = this.#direct(d, from, this.#pivot)
        const b = this.#direct(d, this.#pivot, to)
        if (a && b) return multiplyRates(a, b)
      }
    }
    throw new RateUnavailableError(`No ${from}->${to} rate on or within 7 days before ${date}`)
  }
}

export interface FrankfurterOptions {
  /** Default https://api.frankfurter.dev/v1 (self-hostable; set your own instance here). */
  baseUrl?: string
  fetch?: typeof fetch
  /** Attempts per request, with exponential backoff. Default 4. */
  attempts?: number
  /** Base backoff in ms. Default 250. */
  backoffMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

interface FrankfurterResponse {
  date?: string
  rates?: Record<string, number>
}

interface FrankfurterRange {
  rates?: Record<string, Record<string, number>>
}

/** ECB reference rates via Frankfurter (no key). Fetches only from the configured base URL, never from user input. */
export class FrankfurterRateSource implements RateSource {
  #base: string
  #fetch: typeof fetch
  #attempts: number
  #backoff: number
  #timeout: number
  #sleep: (ms: number) => Promise<void>

  constructor(opts: FrankfurterOptions = {}) {
    this.#base = (opts.baseUrl ?? 'https://api.frankfurter.dev/v1').replace(/\/$/, '')
    this.#fetch = opts.fetch ?? fetch
    this.#attempts = opts.attempts ?? 4
    this.#backoff = opts.backoffMs ?? 250
    this.#timeout = opts.timeoutMs ?? 10_000
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  async rate(date: IsoDate, from: Currency, to: Currency): Promise<string> {
    assertCurrency(from)
    assertCurrency(to)
    if (from === to) return '1'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RateUnavailableError(`Invalid date ${date}`)
    const url = `${this.#base}/${date}?base=${from}&symbols=${to}`
    let lastErr: unknown
    for (let i = 0; i < this.#attempts; i++) {
      if (i > 0) await this.#sleep(this.#backoff * 2 ** (i - 1))
      try {
        const res = await this.#fetch(url, { signal: AbortSignal.timeout(this.#timeout), headers: { accept: 'application/json' } })
        if (res.status === 404 || res.status === 422) throw new RateUnavailableError(`No ${from}->${to} rate for ${date}`)
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`Frankfurter HTTP ${res.status}`)
          continue
        }
        if (!res.ok) throw new RateUnavailableError(`Frankfurter HTTP ${res.status}`)
        const body = (await res.json()) as FrankfurterResponse
        const value = body.rates?.[to]
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new RateUnavailableError(`Frankfurter returned no ${to} rate`)
        return decimalToString(parseDecimal(value))
      } catch (err) {
        if (err instanceof RateUnavailableError) throw err
        lastErr = err
      }
    }
    throw new RateUnavailableError(`Frankfurter unavailable after ${this.#attempts} attempts: ${String(lastErr)}`)
  }

  /** Every business day's rate from `start` to `end` in one request (dates as published; weekends absent). */
  async range(start: IsoDate, end: IsoDate, from: Currency, to: Currency): Promise<Map<IsoDate, string>> {
    assertCurrency(from)
    assertCurrency(to)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new RateUnavailableError('Invalid date range')
    const url = `${this.#base}/${start}..${end}?base=${from}&symbols=${to}`
    let lastErr: unknown
    for (let i = 0; i < this.#attempts; i++) {
      if (i > 0) await this.#sleep(this.#backoff * 2 ** (i - 1))
      try {
        const res = await this.#fetch(url, { signal: AbortSignal.timeout(this.#timeout), headers: { accept: 'application/json' } })
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`Frankfurter HTTP ${res.status}`)
          continue
        }
        if (!res.ok) throw new RateUnavailableError(`Frankfurter HTTP ${res.status}`)
        const body = (await res.json()) as FrankfurterRange
        const out = new Map<IsoDate, string>()
        for (const [d, r] of Object.entries(body.rates ?? {})) {
          const v = r[to]
          if (/^\d{4}-\d{2}-\d{2}$/.test(d) && typeof v === 'number' && Number.isFinite(v) && v > 0) out.set(d, decimalToString(parseDecimal(v)))
        }
        return out
      } catch (err) {
        if (err instanceof RateUnavailableError) throw err
        lastErr = err
      }
    }
    throw new RateUnavailableError(`Frankfurter unavailable after ${this.#attempts} attempts: ${String(lastErr)}`)
  }
}

/** Caches every rate in the ledger store, so the ledger is reproducible even if the upstream changes or is down. */
export class CachedRateSource implements RateSource {
  #store: LedgerStore
  #upstream: RateSource
  #sourceName: string

  constructor(store: LedgerStore, upstream: RateSource, sourceName = 'frankfurter') {
    this.#store = store
    this.#upstream = upstream
    this.#sourceName = sourceName
  }

  async rate(date: IsoDate, from: Currency, to: Currency): Promise<string> {
    if (from === to) return '1'
    const cached = await this.#store.getRate(date, from, to)
    if (cached) return cached
    const r = await this.#upstream.rate(date, from, to)
    await this.#store.saveRate(date, from, to, r, this.#sourceName)
    return r
  }

  /** From the store only: the day itself, else the closest earlier business day kept (ranged fetches skip weekends). */
  async cached(date: IsoDate, from: Currency, to: Currency): Promise<string | null> {
    if (from === to) return '1'
    for (let back = 0; back <= 7; back++) {
      const r = await this.#store.getRate(back === 0 ? date : previousDay(date, back), from, to)
      if (r) return r
    }
    return null
  }

  async prefetch(needs: ReadonlyArray<{ date: IsoDate; from: Currency; to: Currency }>): Promise<void> {
    const byPair = new Map<string, IsoDate[]>()
    for (const n of needs) {
      if (n.from === n.to) continue
      const k = `${n.from}|${n.to}`
      byPair.set(k, [...(byPair.get(k) ?? []), n.date])
    }
    const up = this.#upstream as RateSource & { range?: (s: IsoDate, e: IsoDate, f: Currency, t: Currency) => Promise<Map<IsoDate, string>> }
    for (const [k, dates] of byPair) {
      const [from, to] = k.split('|') as [Currency, Currency]
      dates.sort()
      if (up.range) {
        const got = await up.range(previousDay(dates[0] as IsoDate, 7), dates[dates.length - 1] as IsoDate, from, to)
        for (const [d, r] of got) if (!(await this.#store.getRate(d, from, to))) await this.#store.saveRate(d, from, to, r, this.#sourceName)
      } else {
        for (const d of [...new Set(dates)].slice(0, 50)) if (!(await this.cached(d, from, to))) await this.rate(d, from, to).catch(() => undefined)
      }
    }
  }
}
