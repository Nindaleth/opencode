import { afterAll, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionArtifact } from "@/session/artifact"
import { SessionArtifactCleanup } from "@/session/artifact-cleanup"
import { Session } from "@/session/session"
import { SessionID, PartID } from "@/session/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { pollWithTimeout, testEffect } from "../lib/effect"
import fs from "fs"
import os from "os"
import path from "path"

const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-test-artifact-")))

const globalReplacement: LayerNode.Replacement = [Global.node, Layer.succeed(Global.Service, Global.make({ data }))]

const { live: it } = testEffect(LayerNode.compile(SessionArtifact.node, [globalReplacement]))

const lifecycle = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionArtifact.node,
      Session.node,
      Database.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      globalReplacement,
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

afterAll(() => fs.rmSync(data, { recursive: true, force: true }))

const sessionID = SessionID.make("ses_artifact_a")
const otherSessionID = SessionID.make("ses_artifact_b")
const partID = PartID.make("prt_artifact_1")

describe("SessionArtifact", () => {
  it(
    "round-trips bytes",
    Effect.gen(function* () {
      const store = yield* SessionArtifact.Service
      const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff])

      yield* store.write(sessionID, partID, bytes)

      expect(yield* store.read(sessionID, partID)).toEqual(bytes)

      yield* store.removeSession(sessionID)
    }),
  )

  it(
    "returns undefined for a missing artifact",
    Effect.gen(function* () {
      const store = yield* SessionArtifact.Service
      expect(yield* store.read(sessionID, PartID.make("prt_absent"))).toBeUndefined()
    }),
  )

  it(
    "removeSession deletes every artifact for that session and leaves others alone",
    Effect.gen(function* () {
      const store = yield* SessionArtifact.Service
      const bytes = new Uint8Array([1, 2, 3])

      yield* store.write(sessionID, partID, bytes)
      yield* store.write(sessionID, PartID.make("prt_artifact_2"), bytes)
      yield* store.write(otherSessionID, partID, bytes)

      yield* store.removeSession(sessionID)

      expect(yield* store.read(sessionID, partID)).toBeUndefined()
      expect(yield* store.read(sessionID, PartID.make("prt_artifact_2"))).toBeUndefined()
      expect(yield* store.read(otherSessionID, partID)).toEqual(bytes)

      yield* store.removeSession(otherSessionID)
    }),
  )

  it(
    "sweep removes directories for sessions that no longer exist",
    Effect.gen(function* () {
      const store = yield* SessionArtifact.Service
      const bytes = new Uint8Array([9])

      yield* store.write(sessionID, partID, bytes)
      yield* store.write(otherSessionID, partID, bytes)

      yield* store.sweep(new Set<string>([otherSessionID]))

      expect(yield* store.read(sessionID, partID)).toBeUndefined()
      expect(yield* store.read(otherSessionID, partID)).toEqual(bytes)

      yield* store.removeSession(otherSessionID)
    }),
  )

  it(
    "never writes outside the managed directory",
    Effect.gen(function* () {
      const store = yield* SessionArtifact.Service
      const root = path.join(data, SessionArtifact.MANAGED_DIRECTORY)

      // The branded constructor only enforces the "ses" prefix, so traversal has
      // to be rejected by the store. Values without the prefix are cast here to
      // cover IDs that never went through the constructor at all.
      const hostile = ["ses/../../escape", "ses/../escape", "ses\u0000null", "../escape", "/etc/passwd"]

      for (const value of hostile) {
        const exit = yield* store.write(value as SessionID, partID, new Uint8Array([1])).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }

      expect(fs.existsSync(path.join(path.dirname(root), "escape"))).toBe(false)
      expect(fs.existsSync(path.join(root, "..", "..", "escape"))).toBe(false)
    }),
  )

  it(
    "rejects a traversing part id",
    Effect.gen(function* () {
      const store = yield* SessionArtifact.Service
      const exit = yield* store.write(sessionID, "prt/../escape" as PartID, new Uint8Array([1])).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )
})

describe("SessionArtifact lifecycle", () => {
  lifecycle.instance("removes artifacts when the session is deleted", () =>
    Effect.gen(function* () {
      const store = yield* SessionArtifact.Service
      const session = yield* Session.Service
      const info = yield* session.create({ title: "artifact-lifecycle" })
      const part = PartID.make("prt_lifecycle_1")
      const bytes = new Uint8Array([7, 7, 7])

      yield* store.write(info.id, part, bytes)
      expect(yield* store.read(info.id, part)).toEqual(bytes)

      yield* session.remove(info.id)

      expect(yield* store.read(info.id, part)).toBeUndefined()
    }),
  )

  lifecycle.instance("sweep keeps blobs for live sessions and drops orphans", () =>
    Effect.gen(function* () {
      const store = yield* SessionArtifact.Service
      const session = yield* Session.Service
      const info = yield* session.create({ title: "artifact-sweep" })
      const orphan = SessionID.make("ses_artifact_orphan")
      const bytes = new Uint8Array([4, 2])

      yield* store.write(info.id, partID, bytes)
      yield* store.write(orphan, partID, bytes)

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(SessionArtifactCleanup.layer)
          yield* pollWithTimeout(
            store.read(orphan, partID).pipe(Effect.map((found) => (found === undefined ? true : undefined))),
            "sweep never removed the orphan directory",
          )
        }),
      )

      expect(yield* store.read(info.id, partID)).toEqual(bytes)

      yield* session.remove(info.id)
    }),
  )
})
