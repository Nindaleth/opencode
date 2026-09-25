import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Option } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { SessionArtifact } from "@opencode/core/session/artifact"
import { Session } from "@opencode/core/session"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const withStore = <A, E, R>(body: (store: SessionArtifact.Interface, root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const store = yield* SessionArtifact.Service
        return yield* body(store, tmp.path)
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([SessionArtifact.node, FSUtil.node]), [
            Global.node.replace(Global.layerWith({ data: tmp.path })),
          ]),
        ),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("SessionArtifact", () => {
  it.live("Flat blob keys allowed a second session to read the same file", () =>
    withStore((store, root) =>
      Effect.gen(function* () {
        const owner = Session.ID.make("ses_artifact_owner")
        const other = Session.ID.make("ses_artifact_other")
        const ref = yield* store.write(owner, {
          name: "../report.zip",
          mime: "application/zip",
          bytes: Uint8Array.of(42),
        })
        expect(ref.name).toBe("report.zip")
        expect(yield* store.read(owner, ref.key)).toEqual(Uint8Array.of(42))
        expect(Option.isNone(yield* Effect.option(store.read(other, ref.key)))).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(path.join(root, "blob", owner, ref.key)).exists())).toBe(true)
      }),
    ),
  )

  it.live("Hostile filenames were used as paths instead of display names", () =>
    withStore((store, root) =>
      Effect.gen(function* () {
        const sessionID = Session.ID.make("ses_artifact_filename")
        const bytes = Uint8Array.of(0, 42, 255)
        const ref = yield* store.write(sessionID, { name: "../../report.zip", mime: "application/zip", bytes })
        expect(ref.name).toBe("report.zip")
        expect(ref.size).toBe(3)
        expect(ref.key).not.toContain("report")
        expect(yield* store.read(sessionID, ref.key)).toEqual(bytes)
        expect(
          new Uint8Array(
            yield* Effect.promise(() => Bun.file(path.join(root, "blob", sessionID, ref.key)).arrayBuffer()),
          ),
        ).toEqual(bytes)
      }),
    ),
  )

  it.live("Imported artifact keys could read files outside the session directory", () =>
    withStore((store, root) =>
      Effect.gen(function* () {
        const sessionID = Session.ID.make("ses_artifact_path")
        yield* Effect.promise(() => Bun.write(path.join(root, "private.txt"), "private"))
        expect(Option.isNone(yield* Effect.option(store.read(sessionID, "../private.txt")))).toBe(true)
        expect(Option.isNone(yield* Effect.option(store.read(sessionID, "blob_missing")))).toBe(true)
        expect(
          Option.isNone(yield* Effect.option(store.read(Session.ID.make("ses_../../escape"), "blob_missing"))),
        ).toBe(true)
        expect(
          Option.isNone(
            yield* Effect.option(
              store.write(Session.ID.make("ses_../../escape"), {
                name: "bad",
                mime: "application/octet-stream",
                bytes: Uint8Array.of(1),
              }),
            ),
          ),
        ).toBe(true)
      }),
    ),
  )
})
