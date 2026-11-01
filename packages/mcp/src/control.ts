// The person-facing control surface: "Connect your AI" drawer, consent screen, Review, Preferences.
// Every call here is made by a signed-in person (never by an AI); S0/S8 authenticate them before calling.

import { createHash } from 'node:crypto'
import type { GrantShape, Id, PersonId, WorkspaceId } from '@agfn/contracts'
import { newId } from '@agfn/db'
import { appendActivity, listActivity, verifyChain, type ActivityQuery, type ActivityRow, type ChainVerdict } from './activity.ts'
import { controlSentence, defaultGrantShape, PUBLIC_DEMO_CLIENT, grantState, isWidening, normalizeShape, shapeToColumns, type ControlSentence, type Grant } from './grants.ts'
import { generateKey } from './keys.ts'
import type { Clock, ControlHooks, FinanceReader, PeopleDirectory } from './ports.ts'
import { ToolError } from './scope.ts'
import type { ControlStore } from './store/store.ts'
import type { AgentKeysTable, WriteRequestsTable } from './store/schema.ts'
import type { PipelineResult, WritePipeline } from './writes.ts'

/** MASTER §9: passkey re-check within 10 minutes before creating AI access or widening it. */
export const PASSKEY_WINDOW_MS = 10 * 60_000
/**
 * An account's first AI connection: a sign-up or sign-in within this long counts as the check, so someone who signs up,
 * detours through their bank or Claude's settings and comes back isn't stopped right before their first answer.
 * Every later connection and every widening keeps PASSKEY_WINDOW_MS (docs/security/threat-model.md).
 */
export const FIRST_GRANT_WINDOW_MS = 60 * 60_000
export const MAX_KEY_DAYS = 366

export interface PersonActor {
  workspaceId: WorkspaceId
  personId: PersonId
  ip?: string
  userAgent?: string
}

export interface GrantSummary {
  grant: Grant
  sentence: ControlSentence
  keys: Array<Pick<AgentKeysTable, 'id' | 'name' | 'display_prefix' | 'last4' | 'expires_at' | 'last_used_at' | 'created_at'>>
}

export interface CreatedKey {
  /** Shown once. Aggregate keeps only its hash. */
  key: string
  keyId: Id
  grant: Grant
  sentence: ControlSentence
}

export interface PendingWrite {
  id: Id
  op: string
  entityId: string | null
  createdAt: string
  heldBecause: string | null
  by: string
  reason: string | null
  payload: Record<string, unknown>
}

export interface ControlDeps {
  store: ControlStore
  reader: FinanceReader
  people: PeopleDirectory
  pipeline: WritePipeline
  clock: Clock
  hooks?: ControlHooks
  /** get_investments is on (AGFN_TOOL_INVESTMENTS): equity is named "the cap table and investments". */
  investments?: boolean
}

/** The AI disclosure as shown to the person: its version and the exact line (the AI's name filled in). */
export interface ConsentShown {
  version: string
  text: string
}

export interface NewGrantInput {
  clientId: string
  clientName: string
  kind: 'oauth' | 'key'
  shape: GrantShape
  /** Recorded on the grant as consent evidence (Intuit, 2026-10-27); the consent screen and key creation pass it. */
  consent?: ConsentShown
}

export class ControlApi {
  readonly deps: ControlDeps
  constructor(deps: ControlDeps) {
    this.deps = deps
  }

  // ---------- lookups for S0 ----------

  /** For the OAuth token verifier: is this grant live, and whose is it? */
  async getGrant(grantId: Id): Promise<Pick<Grant, 'id' | 'workspaceId' | 'personId' | 'revokedAt' | 'expiresAt' | 'clientId' | 'clientName' | 'write'> | null> {
    const g = await this.deps.store.getGrantById(grantId)
    return g ? { id: g.id, workspaceId: g.workspaceId, personId: g.personId, revokedAt: g.revokedAt, expiresAt: g.expiresAt, clientId: g.clientId, clientName: g.clientName, write: g.write } : null
  }

  /** What the consent screen shows before anything is saved. */
  async proposeGrant(actor: PersonActor, clientName: string, shape?: GrantShape): Promise<{ shape: GrantShape; sentence: ControlSentence; entities: Array<{ id: string; name: string; kind: string }> }> {
    const now = this.deps.clock.now()
    const s = normalizeShape(shape ?? defaultGrantShape(now), now)
    const entities = await this.deps.people.entitiesFor(actor.workspaceId, actor.personId)
    const draft = this.draftGrant(actor, { clientId: 'preview', clientName, kind: 'oauth', shape: s }, now)
    return { shape: s, sentence: controlSentence(draft, entities, now, { investments: this.deps.investments === true }), entities }
  }

  // ---------- grants ----------

  async createGrant(actor: PersonActor, input: NewGrantInput): Promise<Grant> {
    if (await this.isFirstGrant(actor)) {
      if (!(await this.deps.people.requireRecentPasskey(actor.personId, FIRST_GRANT_WINDOW_MS, 'first_grant'))) throw new ToolError('forbidden', 'Confirm with your passkey first.', 'step_up_required')
    } else await this.requirePasskey(actor, 'create_grant')
    return this.insertNewGrant(actor, input)
  }

  /**
   * Demo workspaces only (settings "demo" = true): an AI grant without the passkey check, which a seeding step cannot
   * pass. Everything else (within-person limits, the activity row) is the same as createGrant.
   */
  async createDemoGrant(actor: PersonActor, input: { clientName: string; shape: GrantShape }): Promise<Grant> {
    const row = await this.deps.store.db.selectFrom('settings').select('value_json').where('workspace_id', '=', actor.workspaceId).where('key', '=', 'demo').executeTakeFirst()
    if (!row || !['true', '"true"'].includes(row.value_json)) throw new ToolError('forbidden', 'Only demo workspaces can be seeded with an AI connection.')
    return this.insertNewGrant(actor, { clientId: 'demo', clientName: input.clientName, kind: 'oauth', shape: input.shape })
  }

  /** The public no-sign-up demo's connection (apps/server/src/public-demo.ts): read-only, only in the public demo workspace. */
  async createPublicDemoGrant(actor: PersonActor, input: { shape: GrantShape }): Promise<Grant> {
    const row = await this.deps.store.db.selectFrom('settings').select('value_json').where('workspace_id', '=', actor.workspaceId).where('key', '=', 'public_demo').executeTakeFirst()
    if (!row || !['true', '"true"'].includes(row.value_json)) throw new ToolError('forbidden', 'Only the public demo workspace can hold the public demo connection.')
    if (input.shape.write) throw new ToolError('forbidden', 'The public demo connection is read-only.')
    return this.insertNewGrant(actor, { clientId: PUBLIC_DEMO_CLIENT, clientName: 'Public demo', kind: 'oauth', shape: input.shape })
  }

  private async insertNewGrant(actor: PersonActor, input: NewGrantInput): Promise<Grant> {
    const { store, clock } = this.deps
    const now = clock.now()
    const shape = normalizeShape(input.shape, now)
    await this.assertWithinPerson(actor, shape)
    const clientName = cleanName(input.clientName, 'AI')
    const consent = input.consent
      ? { consent_version: input.consent.version, consent_sha256: createHash('sha256').update(input.consent.text, 'utf8').digest('hex'), consent_sources_json: JSON.stringify(await this.sourcesInScope(actor.workspaceId, shape.entityIds)) }
      : {}
    const row = { id: newId(now.getTime()), workspace_id: actor.workspaceId, person_id: actor.personId, kind: input.kind, client_id: input.clientId.slice(0, 500), client_name: clientName, ...shapeToColumns(shape), created_at: now.toISOString(), updated_at: now.toISOString(), revoked_at: null, revoked_by: null, last_used_at: null, paused_at: null, paused_by: null, ...consent }
    const grant = await store.insertGrant(row)
    const sentence = await this.sentence(grant)
    await this.log(actor, 'grant.create', grant.id, sentence.text)
    return grant
  }

  /** Connector keys of the live connections that reach these companies (the connection's company, or any account's). */
  private async sourcesInScope(workspaceId: WorkspaceId, entityIds: GrantShape['entityIds']): Promise<string[]> {
    let q = this.deps.store.db.selectFrom('connections as c').select('c.connector_key').distinct().where('c.workspace_id', '=', workspaceId).where('c.status', '!=', 'disconnected')
    if (entityIds !== 'all') {
      const ids = entityIds
      q = q.where((eb) => eb.or([eb('c.entity_id', 'in', ids), eb.exists(eb.selectFrom('accounts as a').select('a.id').whereRef('a.connection_id', '=', 'c.id').where('a.entity_id', 'in', ids))]))
    }
    return (await q.execute()).map((r) => r.connector_key).sort()
  }

  /** Change the control sentence. Widening anything needs a fresh passkey check. */
  async updateGrant(actor: PersonActor, grantId: Id, next: GrantShape): Promise<Grant> {
    const { store, clock } = this.deps
    const now = clock.now()
    const g = await this.ownedGrant(actor, grantId)
    if (grantState(g, now) === 'revoked') throw new ToolError('invalid', 'This AI connection was revoked; connect it again instead.')
    const shape = normalizeShape(next, now)
    if (isWidening(g, shape)) await this.requirePasskey(actor)
    await this.assertWithinPerson({ ...actor, personId: g.personId }, shape)
    await store.updateGrant(actor.workspaceId, grantId, { ...shapeToColumns(shape), updated_at: now.toISOString() })
    const updated = (await store.getGrant(actor.workspaceId, grantId))!
    await this.log(actor, 'grant.update', grantId, (await this.sentence(updated)).text)
    return updated
  }

  /** Rename a key's connection (the owner's own label, e.g. "n8n" instead of "Key for my bot"). Not widening. */
  async renameGrant(actor: PersonActor, grantId: Id, name: string): Promise<Grant> {
    const { store, clock } = this.deps
    const g = await this.ownedGrant(actor, grantId)
    if (g.revokedAt) throw new ToolError('invalid', 'This AI connection was revoked; connect it again instead.')
    if (g.kind !== 'key') throw new ToolError('invalid', 'Only keys can be renamed. An app that signed in keeps the name it showed when you approved it.')
    const clean = name.replace(/\s+/g, ' ').trim()
    if (clean.length < 1 || clean.length > 60) throw new ToolError('invalid', 'Give it a name of 1 to 60 characters.')
    if (clean === g.clientName) return g
    await store.updateGrant(actor.workspaceId, grantId, { client_name: clean, updated_at: clock.now().toISOString() })
    await store.renameKeysForGrant(grantId, clean)
    await this.log(actor, 'grant.rename', grantId, `${g.clientName} is now called ${clean}`)
    return (await store.getGrant(actor.workspaceId, grantId))!
  }

  async revokeGrant(actor: PersonActor, grantId: Id): Promise<void> {
    const { store, clock } = this.deps
    const now = clock.now().toISOString()
    const g = await this.ownedGrant(actor, grantId)
    if (g.revokedAt) return
    await store.updateGrant(actor.workspaceId, grantId, { revoked_at: now, revoked_by: actor.personId, updated_at: now })
    await store.revokeKeysForGrant(grantId, now)
    await this.deps.hooks?.onGrantRevoked?.(grantId)
    await this.log(actor, 'grant.revoke', grantId, `${g.clientName} can no longer access Aggregate`)
  }

  /** Pause or resume one AI without revoking it. Resuming is not widening (the grant itself is unchanged). */
  async setGrantPaused(actor: PersonActor, grantId: Id, paused: boolean): Promise<Grant> {
    const { store, clock } = this.deps
    const now = clock.now().toISOString()
    const g = await this.ownedGrant(actor, grantId)
    if (g.revokedAt) throw new ToolError('invalid', 'This AI connection was revoked; connect it again instead.')
    if (Boolean(g.pausedAt) === paused) return g
    await store.updateGrant(actor.workspaceId, grantId, paused ? { paused_at: now, paused_by: actor.personId, updated_at: now } : { paused_at: null, paused_by: null, updated_at: now })
    await this.log(actor, paused ? 'grant.pause' : 'grant.resume', grantId, `${paused ? 'Paused' : 'Resumed'} ${g.clientName}`)
    return (await store.getGrant(actor.workspaceId, grantId))!
  }

  /** Every AI connection the person can see: their own, or everyone's for workspace managers. */
  async listGrants(actor: PersonActor, opts: { includeRevoked?: boolean } = {}): Promise<GrantSummary[]> {
    const manager = await this.deps.people.canManageWorkspace(actor.workspaceId, actor.personId)
    const grants = await this.deps.store.listGrants(actor.workspaceId, { personId: manager ? undefined : actor.personId, includeRevoked: opts.includeRevoked })
    const keys = await this.deps.store.listKeys(actor.workspaceId, { grantIds: grants.map((g) => g.id), includeRevoked: opts.includeRevoked })
    const out: GrantSummary[] = []
    for (const g of grants) {
      out.push({
        grant: g,
        sentence: await this.sentence(g),
        keys: keys.filter((k) => k.grant_id === g.id).map((k) => ({ id: k.id, name: k.name, display_prefix: k.display_prefix, last4: k.last4, expires_at: k.expires_at, last_used_at: k.last_used_at, created_at: k.created_at })),
      })
    }
    return out
  }

  async describeGrant(actor: PersonActor, grantId: Id): Promise<GrantSummary & { activity: ActivityRow[] }> {
    const g = await this.ownedGrant(actor, grantId)
    const [summary] = (await this.listGrants(actor, { includeRevoked: true })).filter((s) => s.grant.id === g.id)
    return { ...summary!, activity: await listActivity(this.deps.store.db, actor.workspaceId, { grantId, limit: 100 }) }
  }

  // ---------- agent keys ----------

  async createAgentKey(actor: PersonActor, input: { name: string; shape: GrantShape; ipAllowlist?: string[]; consent?: ConsentShown }): Promise<CreatedKey> {
    const { store, clock } = this.deps
    const now = clock.now()
    if (input.shape.expiresAt === null) throw new ToolError('invalid', 'Agent keys must expire.', `Pick an expiry up to ${MAX_KEY_DAYS} days.`)
    if (Date.parse(input.shape.expiresAt) - now.getTime() > MAX_KEY_DAYS * 86_400_000) throw new ToolError('invalid', `Agent keys can last at most ${MAX_KEY_DAYS} days.`)
    const ips = input.ipAllowlist?.map((ip) => ip.trim()).filter(Boolean)
    if (ips && (ips.length > 50 || ips.some((ip) => !/^[0-9a-fA-F:.]{2,45}$/.test(ip)))) throw new ToolError('invalid', 'IP allowlist must be up to 50 plain IP addresses.')
    const keyId = newId(now.getTime())
    const name = cleanName(input.name, 'Agent key')
    const grant = await this.createGrant(actor, { clientId: `key:${keyId}`, clientName: name, kind: 'key', shape: input.shape, ...(input.consent ? { consent: input.consent } : {}) })
    const k = generateKey()
    await store.insertKey({ id: keyId, workspace_id: actor.workspaceId, grant_id: grant.id, name, display_prefix: k.displayPrefix, last4: k.last4, key_hash: k.hash, ip_allowlist_json: ips?.length ? JSON.stringify(ips) : null, expires_at: grant.expiresAt, created_by: actor.personId, created_at: now.toISOString(), revoked_at: null, last_used_at: null })
    await this.log(actor, 'agent_key.create', keyId, `${k.displayPrefix}…${k.last4}`)
    return { key: k.plaintext, keyId, grant, sentence: await this.sentence(grant) }
  }

  async revokeAgentKey(actor: PersonActor, keyId: Id): Promise<void> {
    const key = await this.deps.store.getKey(actor.workspaceId, keyId)
    if (!key) throw new ToolError('not_found', 'No such key.')
    await this.revokeGrant(actor, key.grant_id)
  }

  // ---------- pause, review default ----------

  async pauseAll(actor: PersonActor): Promise<void> {
    await this.requireManager(actor)
    const s = await this.deps.store.getAiSettings(actor.workspaceId)
    const now = this.deps.clock.now().toISOString()
    await this.deps.store.putAiSettings({ ...s, paused_at: now, paused_by: actor.personId, updated_at: now })
    await this.log(actor, 'ai.pause', null, 'Paused all AI access')
  }

  async resumeAll(actor: PersonActor): Promise<void> {
    await this.requireManager(actor)
    const s = await this.deps.store.getAiSettings(actor.workspaceId)
    const now = this.deps.clock.now().toISOString()
    await this.deps.store.putAiSettings({ ...s, paused_at: null, paused_by: null, updated_at: now })
    await this.log(actor, 'ai.resume', null, 'Resumed AI access')
  }

  async setReviewDefault(actor: PersonActor, mode: 'instant' | 'review_all'): Promise<void> {
    await this.requireManager(actor)
    if (mode === 'instant') await this.requirePasskey(actor)
    const s = await this.deps.store.getAiSettings(actor.workspaceId)
    const now = this.deps.clock.now().toISOString()
    await this.deps.store.putAiSettings({ ...s, review_mode_default: mode, updated_at: now })
    await this.log(actor, 'ai.review_default', null, mode === 'review_all' ? 'AI changes wait for review' : 'AI changes apply immediately')
  }

  async aiSettings(actor: PersonActor): Promise<{ paused: boolean; pausedAt: string | null; reviewModeDefault: 'instant' | 'review_all' }> {
    const s = await this.deps.store.getAiSettings(actor.workspaceId)
    return { paused: Boolean(s.paused_at), pausedAt: s.paused_at, reviewModeDefault: s.review_mode_default }
  }

  // ---------- activity ----------

  /** Managers see everything; others see their own actions and their own AIs. */
  async activity(actor: PersonActor, q: ActivityQuery = {}): Promise<ActivityRow[]> {
    const manager = await this.deps.people.canManageWorkspace(actor.workspaceId, actor.personId)
    if (q.grantId) await this.ownedGrant(actor, q.grantId)
    return listActivity(this.deps.store.db, actor.workspaceId, manager || q.grantId ? q : { ...q, personId: actor.personId })
  }

  async verifyActivity(actor: PersonActor): Promise<ChainVerdict> {
    await this.requireManager(actor)
    return verifyChain(this.deps.store.db, actor.workspaceId)
  }

  // ---------- review of AI writes ----------

  async pendingWrites(actor: PersonActor): Promise<PendingWrite[]> {
    const rows = await this.deps.store.listWrites(actor.workspaceId, { status: 'pending_review' })
    const out: PendingWrite[] = []
    for (const r of rows) {
      if (!r.entity_id) continue
      if (!(await this.deps.people.can({ kind: 'person', personId: actor.personId, workspaceId: actor.workspaceId }, 'edit', r.entity_id, 'transactions'))) continue
      out.push({ id: r.id, op: r.op, entityId: r.entity_id, createdAt: r.created_at, heldBecause: r.hold_reason, by: await this.byLabel(r), reason: r.reason, payload: JSON.parse(r.payload_json) as Record<string, unknown> })
    }
    return out
  }

  /** Apply a held write, optionally with the reviewer's corrections (amount, date, counterparty, category, note). */
  async approveWrite(actor: PersonActor, writeId: Id, edits?: Record<string, string>): Promise<PipelineResult> {
    return this.deps.pipeline.approve({ kind: 'person', workspaceId: actor.workspaceId, personId: actor.personId, label: await this.deps.people.displayName(actor.personId), ip: actor.ip, userAgent: actor.userAgent }, writeId, edits)
  }

  async rejectWrite(actor: PersonActor, writeId: Id, note?: string): Promise<void> {
    return this.deps.pipeline.reject({ kind: 'person', workspaceId: actor.workspaceId, personId: actor.personId, label: await this.deps.people.displayName(actor.personId), ip: actor.ip, userAgent: actor.userAgent }, writeId, note)
  }

  /** Undo by write id or by the record it created. */
  async undo(actor: PersonActor, ref: { writeId?: Id; recordId?: Id }): Promise<void> {
    let id = ref.writeId
    if (!id && ref.recordId) id = (await this.deps.store.findWriteByRecord(actor.workspaceId, ref.recordId))?.id
    if (!id) throw new ToolError('not_found', 'Nothing to undo for that record.')
    await this.deps.pipeline.undo({ kind: 'person', workspaceId: actor.workspaceId, personId: actor.personId, label: await this.deps.people.displayName(actor.personId), ip: actor.ip, userAgent: actor.userAgent }, id)
  }

  // ---------- internals ----------

  private draftGrant(actor: PersonActor, input: { clientId: string; clientName: string; kind: 'oauth' | 'key'; shape: GrantShape }, now: Date): Grant {
    const iso = now.toISOString()
    return { id: 'draft', workspaceId: actor.workspaceId, personId: actor.personId, kind: input.kind, clientId: input.clientId, clientName: cleanName(input.clientName, 'AI'), ...input.shape, createdAt: iso, updatedAt: iso, revokedAt: null, lastUsedAt: null, pausedAt: null }
  }

  private async sentence(g: Grant): Promise<ControlSentence> {
    const entities = await this.deps.people.entitiesFor(g.workspaceId, g.personId)
    return controlSentence(g, entities, this.deps.clock.now(), { investments: this.deps.investments === true })
  }

  private async ownedGrant(actor: PersonActor, grantId: Id): Promise<Grant> {
    const g = await this.deps.store.getGrant(actor.workspaceId, grantId)
    if (!g) throw new ToolError('not_found', 'No such AI connection.')
    if (g.personId !== actor.personId && !(await this.deps.people.canManageWorkspace(actor.workspaceId, actor.personId))) throw new ToolError('not_found', 'No such AI connection.')
    return g
  }

  /** A grant may only name entities the person can see, and may only write if the person can add something there. */
  private async assertWithinPerson(actor: PersonActor, shape: GrantShape): Promise<void> {
    const visible = await this.deps.people.entitiesFor(actor.workspaceId, actor.personId)
    if (shape.entityIds !== 'all') {
      const bad = shape.entityIds.filter((id) => !visible.some((e) => e.id === id))
      if (bad.length) throw new ToolError('forbidden', "You can't give an AI access to companies you can't see.")
    }
    if (shape.write) {
      const scope = shape.entityIds === 'all' ? visible : visible.filter((e) => (shape.entityIds as string[]).includes(e.id))
      const actorP = { kind: 'person' as const, personId: actor.personId, workspaceId: actor.workspaceId }
      let any = false
      for (const e of scope) for (const d of shape.dataTypes) if (!any && d !== 'personal' && (await this.deps.people.can(actorP, 'add', e.id, d))) any = true
      if (!any) throw new ToolError('forbidden', "You can't let an AI add records you can't add yourself.")
    }
  }

  /** No AI connection or key of this person's in this workspace yet, revoked ones included (demo seeds don't count). */
  private async isFirstGrant(actor: PersonActor): Promise<boolean> {
    const all = await this.deps.store.listGrants(actor.workspaceId, { personId: actor.personId, includeRevoked: true })
    return !all.some((g) => g.clientId !== 'demo' && g.clientId !== PUBLIC_DEMO_CLIENT)
  }

  private async requirePasskey(actor: PersonActor, purpose?: 'create_grant'): Promise<void> {
    if (!(await this.deps.people.requireRecentPasskey(actor.personId, PASSKEY_WINDOW_MS, purpose))) {
      throw new ToolError('forbidden', 'Confirm with your passkey first.', 'step_up_required')
    }
  }

  private async requireManager(actor: PersonActor): Promise<void> {
    if (!(await this.deps.people.canManageWorkspace(actor.workspaceId, actor.personId))) throw new ToolError('forbidden', 'Only an owner or admin can do this.')
  }

  private async byLabel(r: WriteRequestsTable): Promise<string> {
    if (r.grant_id) {
      const g = await this.deps.store.getGrant(r.workspace_id, r.grant_id)
      if (g) return `${g.clientName} · ${await this.deps.people.displayName(g.personId)}`
    }
    return r.person_id ? await this.deps.people.displayName(r.person_id) : 'Aggregate'
  }

  private async log(actor: PersonActor, action: string, targetId: string | null, detail: string): Promise<void> {
    await appendActivity(
      this.deps.store.db,
      { workspaceId: actor.workspaceId, actorKind: 'person', personId: actor.personId, actorLabel: await this.deps.people.displayName(actor.personId), action, targetType: action.split('.')[0] ?? null, targetId, status: 'ok', detail, ip: actor.ip ?? null, userAgent: actor.userAgent ?? null },
      this.deps.clock.now(),
    )
  }
}

/** Client and key names are shown in the UI and to AIs: plain text, short. */
function cleanName(name: string, fallback: string): string {
  const s = name.normalize('NFKC').replace(/[\p{C}<>]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60)
  return s || fallback
}
