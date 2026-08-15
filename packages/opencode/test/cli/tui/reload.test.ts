import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { TuiReload } from "@/cli/tui/reload"
import { tmpdirScoped } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

let statuses = new Map<SessionID, SessionStatus.Info>()
let invalidations = 0

const store = LayerNode.compile(LayerNode.group([InstanceStore.node, CrossSpawnSpawner.node]), [
  [
    InstanceStore.bootstrapNode,
    Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
  ],
])
const it = testEffect(
  Layer.mergeAll(
    store,
    Layer.mock(Config.Service)({
      invalidate: () => Effect.sync(() => invalidations++),
    }),
    Layer.mock(SessionStatus.Service)({
      list: () => Effect.succeed(new Map(statuses)),
    }),
  ),
)

const reset = Effect.acquireRelease(
  Effect.sync(() => {
    statuses = new Map()
    invalidations = 0
  }),
  () => Effect.void,
)

describe("TuiReload", () => {
  it.live("replaces only the requested directory and invalidates global config", () =>
    Effect.gen(function* () {
      yield* reset
      const firstDirectory = yield* tmpdirScoped({ git: true })
      const secondDirectory = yield* tmpdirScoped({ git: true })
      const instances = yield* InstanceStore.Service
      const first = yield* instances.load({ directory: firstDirectory })
      const other = yield* instances.load({ directory: secondDirectory })

      expect(yield* TuiReload.reload(firstDirectory)).toEqual({ ok: true })
      expect(yield* instances.load({ directory: firstDirectory })).not.toBe(first)
      expect(yield* instances.load({ directory: secondDirectory })).toBe(other)
      expect(invalidations).toBe(1)
    }),
  )

  for (const status of [
    { type: "busy" as const },
    { type: "retry" as const, attempt: 1, message: "retrying", next: Date.now() + 1000 },
  ]) {
    it.live(`rejects ${status.type} sessions without replacing the instance`, () =>
      Effect.gen(function* () {
        yield* reset
        const directory = yield* tmpdirScoped({ git: true })
        const instances = yield* InstanceStore.Service
        const first = yield* instances.load({ directory })
        statuses.set(SessionID.make(`session-${status.type}`), status)

        expect(yield* TuiReload.reload(directory)).toEqual({
          ok: false,
          message: "Cannot reload while a session is busy or retrying.",
        })
        expect(yield* instances.load({ directory })).toBe(first)
        expect(invalidations).toBe(0)
      }),
    )
  }
})
