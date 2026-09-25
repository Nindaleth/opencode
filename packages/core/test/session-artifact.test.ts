import { describe, expect } from "bun:test"
import path from "path"
import { DateTime, Effect, Option, Schema } from "effect"
import fs from "node:fs/promises"
import { Database } from "@opencode/core/database/database"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { eq, sql } from "drizzle-orm"
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
          AppNodeBuilder.build(LayerNode.group([SessionArtifact.node, Database.node, FSUtil.node]), [
            Global.node.replace(Global.layerWith({ data: tmp.path })),
          ]),
        ),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("SessionArtifact", () => {
  it.live("V1-only directories survived cleanup while scanning every assistant message", () =>
    withStore((store, root) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        const sessionID = Session.ID.make("ses_artifact_live")
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            directory: "/project",
            slug: "live",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        const ref = yield* store.write(sessionID, {
          name: "live.zip",
          mime: "application/zip",
          bytes: Uint8Array.of(42),
        })
        yield* Effect.promise(() => fs.mkdir(path.join(root, "blob", "ses_artifact_v1_only"), { recursive: true }))
        yield* Effect.promise(() => Bun.write(path.join(root, "blob", "ses_artifact_v1_only", "prt_example"), "old"))
        const message = Schema.encodeUnknownSync(SessionMessage.Assistant)(
          SessionMessage.Assistant.make({
            id: SessionMessage.ID.create(),
            type: "assistant",
            agent: Agent.ID.make("build"),
            model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
            content: [SessionMessage.AssistantText.make({ type: "text", text: "x".repeat(32 * 1024) })],
            time: { created: DateTime.makeUnsafe(0) },
          }),
        )
        yield* db
          .insert(SessionMessageTable)
          .values(
            Array.from({ length: 1024 }, (_, index) => ({
              id: SessionMessage.ID.create(),
              session_id: sessionID,
              seq: index + 1,
              type: "assistant" as const,
              data: message,
            })),
          )
          .run()
          .pipe(Effect.orDie)
        let last = Date.now()
        let longestBlock = 0
        const ticker = setInterval(() => {
          const now = Date.now()
          longestBlock = Math.max(longestBlock, now - last)
          last = now
        }, 1)
        yield* store.sweep().pipe(Effect.ensuring(Effect.sync(() => clearInterval(ticker))))
        expect(Math.max(longestBlock, Date.now() - last)).toBeLessThan(60)
        expect(yield* store.read(sessionID, ref.key)).toEqual(Uint8Array.of(42))
        expect(
          yield* Effect.promise(() =>
            Bun.file(path.join(root, "blob", "ses_artifact_v1_only", "prt_example")).exists(),
          ),
        ).toBe(false)
        expect(
          (yield* db.select({ id: SessionMessageTable.id }).from(SessionMessageTable).all().pipe(Effect.orDie)).length,
        ).toBe(1024)
        yield* db
          .delete(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* store.sweep()
        expect(yield* store.read(sessionID, ref.key)).toEqual(Uint8Array.of(42))
      }),
    ),
  )

  it.live("A missing session listing must not erase artifact directories", () =>
    withStore((store, root) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const sessionID = Session.ID.make("ses_artifact_unknown")
        const ref = yield* store.write(sessionID, {
          name: "kept.zip",
          mime: "application/zip",
          bytes: Uint8Array.of(42),
        })
        yield* db.run(sql`DROP TABLE session_v2`).pipe(Effect.orDie)
        yield* store.sweep()
        expect(yield* Effect.promise(() => Bun.file(path.join(root, "blob", sessionID, ref.key)).exists())).toBe(true)
      }),
    ),
  )

  it.live("Cleanup followed symlinks and removed flat files in the blob root", () =>
    withStore((store, root) =>
      Effect.gen(function* () {
        const outside = path.join(root, "outside")
        yield* Effect.promise(() => fs.mkdir(path.join(root, "blob"), { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(outside))
        yield* Effect.promise(() => fs.symlink(outside, path.join(root, "blob", "ses_artifact_link")))
        yield* Effect.promise(() => Bun.write(path.join(root, "blob", "blob_flat"), "flat"))
        yield* store.sweep()
        expect(yield* Effect.promise(() => Bun.file(path.join(root, "blob", "blob_flat")).exists())).toBe(true)
        expect(
          yield* Effect.promise(() =>
            fs.lstat(path.join(root, "blob", "ses_artifact_link")).then((stat) => stat.isSymbolicLink()),
          ),
        ).toBe(true)
      }),
    ),
  )

  it.live("Cleanup failed when the blob root did not exist", () => withStore((store) => store.sweep()))

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
