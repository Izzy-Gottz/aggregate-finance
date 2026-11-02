// Turning a set-aside as written (a tool's input, or the app's) into what the ledger stores, checking that whoever
// writes it can see every account it names: a percent of an account reveals that account's balance.
import type { AccountView, Id, IsoDate, SetAsideView } from '@agfn/contracts'
import { ToolError } from './scope.ts'

export interface AllocationIn {
  accountId: Id
  /** In the account's currency. */
  amount?: { minor: number; currency: string }
  percent?: number
  percentOfInflows?: number
  since?: IsoDate
}

export interface SetAsideIn {
  allocations: AllocationIn[]
  countsInCash?: boolean
  /** null removes it. */
  goal?: { amount: { minor: number; currency: string }; by?: IsoDate } | null
  /** null removes it. */
  note?: string | null
}

/** What a bucket has now, for a change: anything the change leaves out stays as it is. */
export type SetAsideKept = Pick<SetAsideView, 'countsInCash' | 'goal' | 'note'>

/** The stored form (core SetAside). `accounts` are the ones the writer may see, `base` the bucket's company currency. */
export function setAsidePayload(input: SetAsideIn, accounts: readonly AccountView[], base: string, today: IsoDate, kept?: SetAsideKept): Record<string, unknown> {
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const allocations = input.allocations.map((al) => {
    const a = byId.get(al.accountId)
    if (!a) throw new ToolError('not_found', `No account "${al.accountId}" that this connection can see.`, 'Use list_accounts.')
    const given = [al.amount, al.percent, al.percentOfInflows].filter((x) => x !== undefined).length
    if (given !== 1) throw new ToolError('invalid', 'Give one of amount, percent or percent_of_inflows.')
    if (al.since !== undefined && al.percentOfInflows === undefined) throw new ToolError('invalid', 'since goes with percent_of_inflows.')
    if (al.amount) {
      if (al.amount.currency !== a.currency) throw new ToolError('invalid', `${a.name} is in ${a.currency}: give the amount in ${a.currency}.`)
      return { accountId: a.id, kind: 'fixed', minor: al.amount.minor }
    }
    if (al.percent !== undefined) return { accountId: a.id, kind: 'percent', percent: al.percent }
    return { accountId: a.id, kind: 'inflow', percent: al.percentOfInflows, since: al.since ?? today }
  })
  if (input.goal && input.goal.amount.currency !== base) throw new ToolError('invalid', `Give the goal in the company's currency, ${base}.`)
  const goal = input.goal === undefined ? kept?.goal && { amount: kept.goal.target, by: kept.goal.by } : input.goal
  const note = input.note === undefined ? kept?.note : input.note?.trim()
  return {
    allocations,
    countsInCash: input.countsInCash ?? kept?.countsInCash ?? true,
    ...(goal ? { goal: { minor: goal.amount.minor, currency: goal.amount.currency, ...(goal.by ? { by: goal.by } : {}) } } : {}),
    ...(note ? { note } : {}),
  }
}
