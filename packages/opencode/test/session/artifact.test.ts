import { afterAll, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionArtifact } from "@/session/artifact"
import { SessionID, PartID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import fs from "fs"
import os from "os"
import path from "path"

const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-test-artifact-")))

const { live: it } = testEffect(
  LayerNode.compile(SessionArtifact.node, [[Global.node, Layer.succeed(Global.Service, Global.make({ data }))]]),
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
