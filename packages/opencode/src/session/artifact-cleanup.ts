import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Duration, Effect, Exit, Layer, Schedule } from "effect"
import { SessionArtifact } from "./artifact"
import { Session } from "./session"

const INTERVAL = Duration.hours(6)

/** `listGlobal` caps its own limit, and a truncated list would look like orphans. */
const LIMIT = Number.MAX_SAFE_INTEGER

/**
 * Reclaims blob directories whose session ID no longer has a row in `session`,
 * covering crashes mid-delete, manual database edits, and restores from an older
 * database. Blob directories are keyed globally by session ID, so the known-set
 * is the global session list rather than the current project's.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* SessionArtifact.Service
    const session = yield* Session.Service
    const sweep = Effect.gen(function* () {
      const exit = yield* session.listGlobal({ archived: true, limit: LIMIT }).pipe(Effect.exit)
      // A failed listing has to skip the sweep entirely. Falling through with an
      // empty known-set would delete the blobs of every live session.
      if (Exit.isFailure(exit)) {
        yield* Effect.logWarning("skipping artifact sweep, session listing failed", exit.cause)
        return
      }
      yield* store.sweep(new Set<string>(exit.value.map((item) => item.id)))
    })
    // Forked so the first sweep never blocks startup.
    yield* sweep.pipe(Effect.repeat(Schedule.spaced(INTERVAL)), Effect.forkScoped)
  }),
)

export const node = LayerNode.make({
  name: "session-artifact-cleanup",
  layer: layer,
  deps: [SessionArtifact.node, Session.node],
})

export * as SessionArtifactCleanup from "./artifact-cleanup"
