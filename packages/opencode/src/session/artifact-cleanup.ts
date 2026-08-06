import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Duration, Effect, Exit, Layer, Schedule } from "effect"
import { SessionArtifact } from "./artifact"

const INTERVAL = Duration.hours(6)

/**
 * Reclaims blob directories whose session ID no longer has a row in `session`,
 * covering crashes mid-delete, manual database edits, and restores from an older
 * database. Blob directories are keyed globally by session ID, so the known-set
 * is the global session list rather than the current project's.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* SessionArtifact.Service
    const { db } = yield* Database.Service
    const sweep = Effect.gen(function* () {
      // Deliberately unfiltered and unlimited: any session row missing from the
      // known-set has its blobs deleted, so archived rows and rows from other
      // projects have to be present too. Selecting only the ID keeps this cheap
      // enough to run once per open project.
      const exit = yield* db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.orDie, Effect.exit)
      // The query dies rather than failing, so this captures a defect. A failed
      // listing has to skip the sweep entirely: falling through with an empty
      // known-set would delete the blobs of every live session.
      if (Exit.isFailure(exit)) {
        yield* Effect.logWarning("skipping artifact sweep, session listing failed", exit.cause)
        return
      }
      yield* store.sweep(new Set<string>(exit.value.map((row) => row.id)))
    })
    // Forked so the first sweep never blocks startup.
    yield* sweep.pipe(Effect.repeat(Schedule.spaced(INTERVAL)), Effect.forkScoped)
  }),
)

export const node = LayerNode.make({
  name: "session-artifact-cleanup",
  layer: layer,
  deps: [SessionArtifact.node, Database.node],
})

export * as SessionArtifactCleanup from "./artifact-cleanup"
