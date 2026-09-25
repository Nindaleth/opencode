export * as SessionArtifact from "./artifact.js"

import path from "path"
import { Context, Duration, Effect, Exit, Layer, Schedule, Semaphore } from "effect"
import { SessionArtifact } from "@opencode/schema/session-artifact"
import { Session } from "@opencode/schema/session"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Database } from "../database/database.js"
import { SessionTable } from "./sql.js"

export type Ref = SessionArtifact.Ref
export const DIRECTORY = "blob"

export interface Interface {
  readonly write: (
    sessionID: Session.ID,
    input: {
      readonly name: string
      readonly mime: string
      readonly bytes: Uint8Array
    },
  ) => Effect.Effect<Ref, FSUtil.Error>
  readonly read: (sessionID: Session.ID, key: string) => Effect.Effect<Uint8Array, FSUtil.Error>
  readonly removeSession: (sessionID: Session.ID) => Effect.Effect<void, FSUtil.Error>
  readonly withCopiedFork: <A, E, R>(
    input: { parentID: Session.ID; sessionID: Session.ID; keys: ReadonlyArray<string> },
    publish: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | FSUtil.Error, R>
  readonly sweep: () => Effect.Effect<void>
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
    const directoryFor = (sessionID: Session.ID) =>
      /^ses_[a-zA-Z0-9_-]+$/.test(sessionID)
        ? Effect.succeed(path.join(directory, sessionID))
        : Effect.fail(new FSUtil.FileSystemError({ method: "sessionDirectory" }))
    const sweep = () =>
      lock.withPermit(
        Effect.gen(function* () {
          const listed = yield* db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.exit)
          if (Exit.isFailure(listed)) {
            yield* Effect.logWarning("skipping artifact sweep, session listing failed", listed.cause)
            return
          }
          const entries = yield* fs.readDirectoryEntries(directory).pipe(Effect.exit)
          if (Exit.isFailure(entries)) {
            if (!(yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => true)))) return
            yield* Effect.logWarning("skipping artifact sweep, directory listing failed", entries.cause)
            return
          }
          const live = new Set<string>(listed.value.map((row) => row.id))
          yield* Effect.forEach(
            entries.value.filter(
              (entry) => entry.type === "directory" && /^ses_[a-zA-Z0-9_-]+$/.test(entry.name) && !live.has(entry.name),
            ),
            (entry) =>
              fs.remove(path.join(directory, entry.name), { recursive: true }).pipe(
                Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
                Effect.catch((error) =>
                  Effect.logWarning("artifact directory removal failed", { directory: entry.name, error }),
                ),
              ),
            { discard: true },
          )
        }),
      )
    return Service.of({
      write: (sessionID, input) =>
        Effect.gen(function* () {
          const key = `blob_${crypto.randomUUID()}`
          yield* fs.writeWithDirs(path.join(yield* directoryFor(sessionID), key), input.bytes)
          return {
            key,
            name: path.basename(input.name.replaceAll("\\", "/")).replace(/[\x00-\x1f\x7f]/g, "_") || key,
            mime: input.mime,
            size: input.bytes.byteLength,
          }
        }),
      read: (sessionID, key) =>
        Effect.gen(function* () {
          const owner = yield* directoryFor(sessionID)
          if (!/^blob_[0-9a-f-]{36}$/.test(key))
            return yield* Effect.fail(new FSUtil.FileSystemError({ method: "readFile" }))
          return yield* fs.readFile(path.join(owner, key))
        }),
      removeSession: (sessionID) =>
        Effect.gen(function* () {
          yield* fs
            .remove(yield* directoryFor(sessionID), { recursive: true })
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void))
        }),
      withCopiedFork: (input, publish) =>
        lock.withPermit(
          Effect.gen(function* () {
            const parent = yield* directoryFor(input.parentID)
            const child = yield* directoryFor(input.sessionID)
            yield* Effect.forEach(
              new Set(input.keys),
              (key) =>
                Effect.gen(function* () {
                  if (!/^blob_[0-9a-f-]{36}$/.test(key)) return
                  const bytes = yield* fs
                    .readFile(path.join(parent, key))
                    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined))
                  if (bytes === undefined) return
                  yield* fs.writeWithDirs(path.join(child, key), bytes)
                }),
              { discard: true },
            )
            return yield* publish
          }),
        ),
      sweep,
    })
  }),
)

const cleanup = Layer.effectDiscard(
  Effect.gen(function* () {
    const artifacts = yield* Service
    yield* artifacts.sweep().pipe(Effect.repeat(Schedule.spaced(Duration.hours(6))), Effect.forkScoped)
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.merge(layer, cleanup.pipe(Layer.provide(layer))),
  deps: [FSUtil.node, Global.node, Database.node],
})
