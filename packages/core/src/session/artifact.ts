export * as SessionArtifact from "./artifact.js"

import path from "path"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema, Semaphore } from "effect"
import { SessionArtifact } from "@opencode/schema/session-artifact"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Database } from "../database/database.js"
import { SessionMessageTable } from "./sql.js"
import { SessionMessage } from "./message.js"
import { and, asc, eq, gt } from "drizzle-orm"

export type Ref = SessionArtifact.Ref
export const DIRECTORY = "blob"
const GRACE = Duration.minutes(5)

export interface Interface {
  readonly write: (input: {
    readonly name: string
    readonly mime: string
    readonly bytes: Uint8Array
  }) => Effect.Effect<Ref, FSUtil.Error>
  readonly read: (key: string) => Effect.Effect<Uint8Array, FSUtil.Error>
  readonly sweep: () => Effect.Effect<void>
  readonly settle: (keys: ReadonlyArray<string>) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionArtifact") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const db = (yield* Database.Service).db
    const directory = path.join(global.data, DIRECTORY)
    const lock = Semaphore.makeUnsafe(1)
    const pending = new Set<string>()
    const sweep = () =>
      lock.withPermit(
        Effect.gen(function* () {
          const live = new Set<string>()
          let cursor: SessionMessage.ID | undefined
          while (true) {
            const rows = yield* db
              .select({ id: SessionMessageTable.id, data: SessionMessageTable.data })
              .from(SessionMessageTable)
              .where(
                cursor === undefined
                  ? eq(SessionMessageTable.type, "assistant")
                  : and(eq(SessionMessageTable.type, "assistant"), gt(SessionMessageTable.id, cursor)),
              )
              .orderBy(asc(SessionMessageTable.id))
              .limit(32)
              .all()
              .pipe(Effect.orDie)
            rows
              .flatMap((row) => {
                const message = Schema.decodeUnknownOption(SessionMessage.Assistant)({
                  ...row.data,
                  id: "msg_sweep",
                  type: "assistant",
                })
                return Option.isSome(message)
                  ? message.value.content.flatMap((part) => (part.type === "artifact" ? [part.key] : []))
                  : []
              })
              .forEach((key) => live.add(key))
            if (rows.length < 32) break
            cursor = rows.at(-1)?.id
            yield* Effect.sleep("1 millis")
          }
          const entries = yield* fs.readDirectoryEntries(directory).pipe(Effect.orElseSucceed(() => []))
          const cutoff = Date.now() - Duration.toMillis(GRACE)
          yield* Effect.forEach(
            entries.filter(
              (entry) =>
                entry.type === "file" &&
                /^blob_[0-9a-f-]{36}$/.test(entry.name) &&
                !live.has(entry.name) &&
                !pending.has(entry.name),
            ),
            (entry) =>
              Effect.gen(function* () {
                const file = path.join(directory, entry.name)
                const info = yield* fs.stat(file).pipe(Effect.option)
                if (Option.isNone(info)) return
                const modified = Option.getOrUndefined(info.value.mtime)
                if (!modified || modified.getTime() >= cutoff) return
                yield* fs.remove(file).pipe(Effect.ignore)
              }),
            { discard: true },
          )
        }),
      )
    return Service.of({
      write: (input) =>
        Effect.gen(function* () {
          const key = `blob_${crypto.randomUUID()}`
          yield* fs.ensureDir(directory)
          yield* fs.writeFile(path.join(directory, key), input.bytes)
          pending.add(key)
          return {
            key,
            name: path.basename(input.name.replaceAll("\\", "/")).replace(/[\x00-\x1f\x7f]/g, "_") || key,
            mime: input.mime,
            size: input.bytes.byteLength,
          }
        }),
      read: (key) =>
        /^blob_[0-9a-f-]{36}$/.test(key)
          ? fs.readFile(path.join(directory, key))
          : Effect.fail(new FSUtil.FileSystemError({ method: "readFile" })),
      sweep,
      settle: (keys) => Effect.sync(() => keys.forEach((key) => pending.delete(key))),
    })
  }),
)

const cleanup = Layer.effectDiscard(
  Effect.gen(function* () {
    const artifacts = yield* Service
    yield* artifacts.sweep().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped)
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.merge(layer, cleanup.pipe(Layer.provide(layer))),
  deps: [FSUtil.node, Global.node, Database.node],
})
