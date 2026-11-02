// Hosted only: an operator reading or changing someone's data from the machine says who and why, and that goes in the
// record before the command runs. One workspace: its own activity log, where its managers' AI sees "Aggregate support ·
// reason" (get_activity) and the staff member's name stays in the stored args. Every workspace or none: the
// operator_access table. Self-hosted: the data is yours, nothing to record.

import { appendActivity } from '@agfn/mcp'
import { newId } from '@agfn/db'
import type { Kysely } from 'kysely'
import { UsageError, flagString, type Io, type ParsedArgs } from './io.ts'

export interface OperatorAccess {
  operator: string
  reason: string
}

const MAX = 300

/** Read before booting, so a missing reason stops the command before it touches anything. Null when self-hosted. */
export function operatorAccess(args: ParsedArgs, io: Io): OperatorAccess | null {
  if (io.env.AGFN_HOSTED !== '1') return null
  const reason = flagString(args, 'reason')?.trim()
  if (!reason) throw new UsageError('hosted: --reason "why" is required, and it goes in the access record')
  const operator = io.env.AGFN_OPERATOR?.trim()
  if (!operator) throw new UsageError('hosted: set AGFN_OPERATOR to your name for the access record')
  return { operator: operator.slice(0, 80), reason: reason.slice(0, MAX) }
}

/** Throws if it can't be written: an access we can't record doesn't happen. */
export async function recordOperatorAccess(db: unknown, access: OperatorAccess | null, command: string, workspaceId?: string): Promise<void> {
  if (!access) return
  const at = new Date()
  if (workspaceId) {
    await appendActivity(db as never, {
      workspaceId,
      actorKind: 'operator',
      actorLabel: 'Aggregate support',
      action: 'operator.access',
      targetType: 'command',
      targetId: command,
      args: { operator: access.operator },
      status: 'ok',
      detail: access.reason,
    }, at)
    return
  }
  await (db as Kysely<any>).insertInto('operator_access').values({
    id: newId(at.getTime()),
    at: at.toISOString(),
    operator: access.operator,
    command,
    reason: access.reason,
  }).execute()
}
