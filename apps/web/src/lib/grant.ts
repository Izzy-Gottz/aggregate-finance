// The control sentence: a GrantShape written as plain words, where each variable part is a slot you can click.
// "Claude can see Acme and Bluebird Studio: balances, transactions, invoices. Can add records. Changes apply immediately.
//  Expires in 90 days."

import type { DataType, GrantShape } from '@agfn/contracts'
import type { EntitySummary } from '../api/types.ts'

export type Slot = 'companies' | 'data' | 'write' | 'review' | 'expiry'

export type Part = { text: string } | { slot: Slot; text: string }

/** Data types an AI can be given, in the order people think about them. 'personal' is a space, not a data type here. */
export const DATA_TYPES: Array<{ key: DataType; label: string }> = [
  { key: 'balances', label: 'balances' },
  { key: 'transactions', label: 'transactions' },
  { key: 'invoices', label: 'invoices' },
  { key: 'bills', label: 'bills' },
  { key: 'buckets', label: 'buckets' },
  { key: 'payroll', label: 'payroll' },
  // Investment positions (cost, marks, MOIC) share the equity grant with the cap table, so the label says both.
  { key: 'equity', label: 'cap table & investments' },
  { key: 'documents', label: 'documents' },
  { key: 'reports', label: 'reports' },
]

export const EXPIRY_CHOICES: Array<{ days: number | null; label: string }> = [
  { days: 30, label: 'in 30 days' },
  { days: 90, label: 'in 90 days' },
  { days: 365, label: 'in a year' },
  { days: null, label: 'never' },
]

const DAY = 86_400_000

/** "Acme", "Acme and Bluebird Studio", "Acme, Bluebird Studio and Harbor Coffee". */
export function listWords(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? ''
  return xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]
}

/**
 * What a new AI or key gets unless changed: everything a company has. Personal stays opt-in, except in a Personal-only
 * workspace, where it's all there is (without it the AI would see nothing).
 */
export function defaultDataTypes(entities: EntitySummary[]): DataType[] {
  const base: DataType[] = ['balances', 'transactions', 'invoices', 'bills', 'buckets', 'payroll', 'equity', 'documents', 'reports']
  return entities.some((e) => e.kind === 'company') ? base : [...base, 'personal']
}

/** Adds Personal when the person has their own Personal space here (others' Personal spaces are never listed to them). */
export function withOwnPersonal(types: DataType[], entities: EntitySummary[]): DataType[] {
  return entities.some((e) => e.kind === 'personal') && !types.includes('personal') ? [...types, 'personal'] : types
}

export function companiesText(shape: GrantShape, entities: EntitySummary[]): string {
  const own = shape.dataTypes.includes('personal')
  if (!entities.some((e) => e.kind === 'company')) return own ? 'your own money' : 'nothing yet'
  const ids = shape.entityIds
  const companies = ids === 'all' ? ['all your companies'] : entities.filter((e) => e.kind === 'company' && ids.includes(e.id)).map((e) => e.name)
  const all = [...companies, ...(own ? ['your own money'] : [])]
  return all.length ? listWords(all) : 'nothing yet'
}

export function dataText(shape: GrantShape): string {
  const types = DATA_TYPES.filter((d) => shape.dataTypes.includes(d.key))
  if (types.length === DATA_TYPES.length) return 'everything'
  if (!types.length) return 'no data'
  return types.map((d) => d.label).join(', ')
}

export function expiryText(shape: GrantShape, now: number = Date.now()): string {
  if (!shape.expiresAt) return 'Never expires'
  const ms = Date.parse(shape.expiresAt) - now
  if (ms <= 0) return 'Expired'
  // Under a day: hours (a 1-hour key isn't "tomorrow"); under an hour: minutes.
  if (ms < 60 * 60_000) return `Expires in ${Math.max(1, Math.round(ms / 60_000))} minutes`
  if (ms < DAY) {
    const h = Math.round(ms / (60 * 60_000))
    return h === 1 ? 'Expires in an hour' : `Expires in ${h} hours`
  }
  const days = Math.max(1, Math.round(ms / DAY))
  if (days === 1) return 'Expires tomorrow'
  if (days < 100) return `Expires in ${days} days`
  if (days < 330) return `Expires in ${Math.round(days / 30)} months`
  return days < 400 ? 'Expires in a year' : `Expires in ${Math.round(days / 365)} years`
}

export function grantSentence(client: string, shape: GrantShape, entities: EntitySummary[], now: number = Date.now()): Part[] {
  return [
    { text: `${client} can see ` },
    { slot: 'companies', text: companiesText(shape, entities) },
    { text: ': ' },
    { slot: 'data', text: dataText(shape) },
    { text: '. ' },
    { slot: 'write', text: shape.write ? 'Can add records' : 'Read only' },
    { text: '. ' },
    { slot: 'review', text: shape.reviewMode === 'instant' ? 'Changes apply immediately' : 'Changes wait for your review' },
    { text: '. ' },
    { slot: 'expiry', text: expiryText(shape, now) },
    { text: '.' },
  ]
}

export const sentenceText = (parts: Part[]): string => parts.map((p) => p.text).join('')

/** The one-line summary used on rows: "all companies · read + add · 2 min ago" (time appended by caller). */
export function grantLine(shape: GrantShape, entities: EntitySummary[]): string {
  const where = shape.entityIds === 'all' ? 'all companies' : companiesText(shape, entities)
  const what = shape.write ? (shape.reviewMode === 'review_all' ? 'read + add (you review)' : 'read + add') : 'read only'
  return `${where} · ${what}`
}

export function expiresAtFor(days: number | null, now: number = Date.now()): string | null {
  return days === null ? null : new Date(now + days * DAY).toISOString()
}

export const CANT_EVER = 'Can’t ever: move money, pay bills, send invoices or emails.'
