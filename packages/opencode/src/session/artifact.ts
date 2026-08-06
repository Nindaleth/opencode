import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect"
import path from "path"
import { PartID, SessionID } from "./schema"

export const MANAGED_DIRECTORY = "blob"

export class ArtifactPathError extends Schema.TaggedErrorClass<ArtifactPathError>()("SessionArtifact.PathError", {
  value: Schema.String,
}) {
  override get message() {
    return `Refusing to use ${JSON.stringify(this.value)} as an artifact path segment`
  }
}

export class ArtifactIOError extends Schema.TaggedErrorClass<ArtifactIOError>()("SessionArtifact.IOError", {
  method: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Artifact ${this.method} failed${detail ? `: ${detail}` : ""}`
  }
}

export type Error = ArtifactPathError | ArtifactIOError

export interface Interface {
  readonly write: (sessionID: SessionID, partID: PartID, bytes: Uint8Array) => Effect.Effect<void, Error>
  readonly read: (sessionID: SessionID, partID: PartID) => Effect.Effect<Uint8Array | undefined, Error>
  readonly removeSession: (sessionID: SessionID) => Effect.Effect<void>
  readonly sweep: (known: ReadonlySet<string>) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionArtifact") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const util = yield* FSUtil.Service
    const global = yield* Global.Service
    const root = path.join(global.data, MANAGED_DIRECTORY)

    const write = Effect.fn("SessionArtifact.write")(function* (
      sessionID: SessionID,
      partID: PartID,
      bytes: Uint8Array,
    ) {
      const directory = yield* sessionDirectory(root, sessionID)
      const file = yield* artifactFile(directory, partID)
      yield* util.ensureDir(directory).pipe(Effect.mapError((cause) => new ArtifactIOError({ method: "write", cause })))
      yield* util
        .writeFile(file, bytes)
        .pipe(Effect.mapError((cause) => new ArtifactIOError({ method: "write", cause })))
    })

    const read = Effect.fn("SessionArtifact.read")(function* (sessionID: SessionID, partID: PartID) {
      const directory = yield* sessionDirectory(root, sessionID)
      const file = yield* artifactFile(directory, partID)
      if (!(yield* util.existsSafe(file))) return undefined
      return yield* util.readFile(file).pipe(Effect.mapError((cause) => new ArtifactIOError({ method: "read", cause })))
    })

    const removeSession = Effect.fn("SessionArtifact.removeSession")(function* (sessionID: SessionID) {
      if (!safeSegment(sessionID)) return
      yield* util.remove(path.join(root, sessionID), { recursive: true }).pipe(Effect.catch(() => Effect.void))
    })

    const sweep = Effect.fn("SessionArtifact.sweep")(function* (known: ReadonlySet<string>) {
      const entries = yield* util.readDirectory(root).pipe(Effect.catch(() => Effect.succeed([] as string[])))
      for (const entry of entries) {
        if (known.has(entry)) continue
        yield* util.remove(path.join(root, entry), { recursive: true }).pipe(Effect.catch(() => Effect.void))
      }
    })

    return Service.of({ write, read, removeSession, sweep })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node, Global.node] })

/** Reclaims blob directories orphaned by crashes, manual database edits, or restores. */
export const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Service
    yield* store.sweep(new Set<string>()).pipe(Effect.repeat(Schedule.spaced(Duration.hours(6))), Effect.forkScoped)
  }),
)

/**
 * Rejects any segment that is not a plain path component. Branded ID constructors
 * only check the identifier prefix, so this is the only barrier between an
 * MCP-supplied value and the filesystem.
 */
function safeSegment(value: string) {
  if (value.length === 0) return false
  if (value.includes("\u0000")) return false
  if (value === "." || value === "..") return false
  return path.basename(value) === value
}

function sessionDirectory(root: string, sessionID: SessionID): Effect.Effect<string, ArtifactPathError> {
  if (!safeSegment(sessionID)) return Effect.fail(new ArtifactPathError({ value: sessionID }))
  return Effect.succeed(path.join(root, sessionID))
}

function artifactFile(directory: string, partID: PartID): Effect.Effect<string, ArtifactPathError> {
  if (!safeSegment(partID)) return Effect.fail(new ArtifactPathError({ value: partID }))
  return Effect.succeed(path.join(directory, partID))
}

export * as SessionArtifact from "./artifact"
