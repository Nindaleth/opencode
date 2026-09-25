export * as SessionCost from "./cost.js"

import { Effect, Option, Schema } from "effect"
import { and, desc, eq, gte, gt, inArray, or, sql } from "drizzle-orm"
import { Agent } from "@opencode/schema/agent"
import { Event } from "@opencode/schema/event"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { SessionEvent } from "@opencode/schema/session-event"
import { SessionMessage } from "@opencode/schema/session-message"
import { Database } from "../database/database.js"
import { EventTable } from "../event/sql.js"
import { SessionMessageTable, SessionTable } from "./sql.js"

export interface Snapshot {
  readonly sessionID: Session.ID
  readonly rootID: Session.ID
  readonly parentID?: Session.ID
  readonly agent: Agent.ID
  readonly step: number
  readonly model: Model.Ref
  readonly rootModel: Model.Ref
  readonly rootUserMessageID: SessionMessage.ID
  readonly cost: { readonly session: number; readonly root: number; readonly descendants: number }
  readonly first: boolean
}

const type = (definition: { type: string; durable: { version: number } }) =>
  Event.versionedType(definition.type, definition.durable.version)

export const snapshot = Effect.fn("SessionCost.snapshot")(function* (input: {
  sessionID: Session.ID
  agent: Agent.ID
  model: Model.Ref
  step: number
}) {
  const db = (yield* Database.Service).db
  const current = yield* db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, input.sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!current) return undefined

  let root = current
  const visited = new Set<Session.ID>()
  while (root.parent_id) {
    if (visited.has(root.id)) return undefined
    visited.add(root.id)
    const parent = yield* db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, root.parent_id))
      .get()
      .pipe(Effect.orDie)
    if (!parent) return undefined
    root = parent
  }

  const prompt = yield* db
    .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, root.id), eq(SessionMessageTable.type, "user")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!prompt) return undefined
  const delivered = yield* db
    .select({ created: EventTable.created })
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, root.id),
        eq(EventTable.seq, prompt.seq),
        eq(EventTable.type, type(SessionEvent.InboxDelivered)),
        sql`json_extract(${EventTable.data}, '$.inboxID') = ${prompt.id}`,
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!delivered) return undefined

  const selected = yield* db
    .select({ data: EventTable.data })
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, root.id),
        eq(EventTable.type, type(SessionEvent.ModelSelected)),
        sql`${EventTable.seq} <= ${prompt.seq}`,
      ),
    )
    .orderBy(desc(EventTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const started = yield* db
    .select({ data: EventTable.data })
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, root.id),
        eq(EventTable.type, type(SessionEvent.Step.Started)),
        gt(EventTable.seq, prompt.seq),
      ),
    )
    .orderBy(EventTable.seq)
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const rootModel =
    Option.getOrUndefined(Schema.decodeUnknownOption(Model.Ref)(selected?.data.model)) ??
    Option.getOrUndefined(Schema.decodeUnknownOption(Model.Ref)(started?.data.model)) ??
    (root.model
      ? Model.Ref.make({
          id: Model.ID.make(root.model.id),
          providerID: Provider.ID.make(root.model.providerID),
        })
      : undefined) ??
    (root.id === input.sessionID ? input.model : undefined)
  if (!rootModel) return undefined

  const descendants: Session.ID[] = []
  let frontier = [root.id]
  while (frontier.length) {
    const rows = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(inArray(SessionTable.parent_id, frontier))
      .all()
      .pipe(Effect.orDie)
    frontier = rows.map((row) => row.id).filter((id) => id !== root.id && !descendants.includes(id))
    descendants.push(...frontier)
  }

  const usageTypes = [SessionEvent.Step.Ended, SessionEvent.Step.Failed, SessionEvent.UsageRecorded].map(type)
  const costs = yield* db
    .select({ sessionID: EventTable.aggregate_id, cost: sql<number>`sum(json_extract(${EventTable.data}, '$.cost'))` })
    .from(EventTable)
    .where(
      and(
        inArray(EventTable.type, usageTypes),
        or(
          and(eq(EventTable.aggregate_id, root.id), gt(EventTable.seq, prompt.seq)),
          descendants.length
            ? and(inArray(EventTable.aggregate_id, descendants), gte(EventTable.created, delivered.created))
            : undefined,
        ),
      ),
    )
    .groupBy(EventTable.aggregate_id)
    .all()
    .pipe(Effect.orDie)
  const amounts = new Map(costs.map((row) => [row.sessionID, row.cost ?? 0]))
  return {
    sessionID: input.sessionID,
    rootID: root.id,
    ...(current.parent_id ? { parentID: current.parent_id } : {}),
    agent: input.agent,
    step: input.step,
    model: input.model,
    rootModel,
    rootUserMessageID: prompt.id,
    cost: {
      session: amounts.get(input.sessionID) ?? 0,
      root: amounts.get(root.id) ?? 0,
      descendants: descendants.reduce((sum, id) => sum + (amounts.get(id) ?? 0), 0),
    },
    first: root.id === input.sessionID && !started,
  } satisfies Snapshot
})
