import { expect, describe } from "bun:test"
import path from "path"
import { DateTime, Effect, Option, Schema } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { SessionArtifact } from "@opencode/core/session/artifact"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Database } from "@opencode/core/database/database"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionTable, SessionMessageTable } from "@opencode/core/session/sql"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { eq } from "drizzle-orm"
import fs from "node:fs/promises"
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
  it.live("Large artifact sweeps blocked other work until every assistant message was scanned", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const artifacts = yield* SessionArtifact.Service
          const db = (yield* Database.Service).db
          yield* db
            .insert(ProjectTable)
            .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
            .run()
            .pipe(Effect.orDie)
          const session = Session.ID.make("ses_blob_large_sweep")
          yield* db
            .insert(SessionTable)
            .values({
              id: session,
              project_id: Project.ID.global,
              directory: "/project",
              slug: "large",
              version: "test",
            })
            .run()
            .pipe(Effect.orDie)
          const ref = yield* artifacts.write({ name: "kept.zip", mime: "application/zip", bytes: Uint8Array.of(42) })
          const orphan = yield* artifacts.write({
            name: "orphan.zip",
            mime: "application/zip",
            bytes: Uint8Array.of(7),
          })
          yield* artifacts.settle([ref.key, orphan.key])
          yield* Effect.promise(() =>
            Promise.all(
              [ref.key, orphan.key].map((key) => fs.utimes(path.join(tmp.path, "blob", key), new Date(0), new Date(0))),
            ),
          )
          const message = SessionMessage.Assistant.make({
            id: SessionMessage.ID.create(),
            type: "assistant",
            agent: Agent.ID.make("build"),
            model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
            content: [SessionMessage.AssistantText.make({ type: "text", text: "x".repeat(32 * 1024) })],
            time: { created: DateTime.makeUnsafe(0) },
          })
          const data = Schema.encodeUnknownSync(SessionMessage.Assistant)(message)
          const finalData = Schema.encodeUnknownSync(SessionMessage.Assistant)({
            ...message,
            content: [...message.content, SessionMessage.AssistantArtifact.make({ type: "artifact", ...ref })],
          })
          yield* db
            .insert(SessionMessageTable)
            .values(
              Array.from({ length: 1024 }, (_, index) => ({
                id: SessionMessage.ID.create(),
                session_id: session,
                seq: index + 1,
                type: "assistant" as const,
                data: index === 1023 ? finalData : data,
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
          yield* artifacts.sweep().pipe(Effect.ensuring(Effect.sync(() => clearInterval(ticker))))
          expect(Math.max(longestBlock, Date.now() - last)).toBeLessThan(60)
          expect(yield* artifacts.read(ref.key)).toEqual(Uint8Array.of(42))
          expect(Option.isNone(yield* Effect.option(artifacts.read(orphan.key)))).toBe(true)
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(LayerNode.group([SessionArtifact.node, Database.node, FSUtil.node]), [
              Global.node.replace(Global.layerWith({ data: tmp.path })),
            ]),
          ),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("Hostile filenames were used as paths instead of display names", () =>
    withStore((store, root) =>
      Effect.gen(function* () {
        const bytes = Uint8Array.of(0, 42, 255)
        const ref = yield* store.write({ name: "../../report.zip", mime: "application/zip", bytes })
        expect(ref.name).toBe("report.zip")
        expect(ref.size).toBe(3)
        expect(ref.key).not.toContain("report")
        expect(yield* store.read(ref.key)).toEqual(bytes)
        expect(
          new Uint8Array(yield* Effect.promise(() => Bun.file(path.join(root, "blob", ref.key)).arrayBuffer())),
        ).toEqual(bytes)
      }),
    ),
  )

  it.live("Unknown blob keys were silently treated as existing artifacts", () =>
    withStore((store) =>
      Effect.gen(function* () {
        expect(Option.isNone(yield* Effect.option(store.read("blob_missing")))).toBe(true)
      }),
    ),
  )

  it.live("Imported artifact keys could read files outside the blob directory", () =>
    withStore((store, root) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(path.join(root, "private.txt"), "private"))
        expect(Option.isNone(yield* Effect.option(store.read("../private.txt")))).toBe(true)
      }),
    ),
  )

  it.live("An active tool artifact older than the sweep grace was removed before publication", () =>
    withStore((store, root) =>
      Effect.gen(function* () {
        const ref = yield* store.write({ name: "long-running.zip", mime: "application/zip", bytes: Uint8Array.of(9) })
        yield* Effect.promise(() => fs.utimes(path.join(root, "blob", ref.key), new Date(0), new Date(0)))
        yield* store.sweep()
        expect(yield* store.read(ref.key)).toEqual(Uint8Array.of(9))
      }),
    ),
  )

  it.live("A fork kept referencing a blob after its parent was deleted", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const artifacts = yield* SessionArtifact.Service
          const db = (yield* Database.Service).db
          const ref = yield* artifacts.write({ name: "report.zip", mime: "application/zip", bytes: Uint8Array.of(42) })
          yield* db
            .insert(ProjectTable)
            .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
            .run()
            .pipe(Effect.orDie)
          const parent = Session.ID.make("ses_blob_parent")
          const child = Session.ID.make("ses_blob_fork")
          yield* db
            .insert(SessionTable)
            .values([
              { id: parent, project_id: Project.ID.global, directory: "/project", slug: "parent", version: "test" },
              {
                id: child,
                parent_id: parent,
                project_id: Project.ID.global,
                directory: "/project",
                slug: "child",
                version: "test",
              },
            ])
            .run()
            .pipe(Effect.orDie)
          const message = SessionMessage.Assistant.make({
            id: SessionMessage.ID.create(),
            type: "assistant",
            agent: Agent.ID.make("build"),
            model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
            content: [SessionMessage.AssistantArtifact.make({ type: "artifact", ...ref })],
            time: { created: DateTime.makeUnsafe(0) },
          })
          yield* db
            .insert(SessionMessageTable)
            .values(
              [parent, child].map((sessionID) => ({
                id: SessionMessage.ID.create(),
                session_id: sessionID,
                seq: 1,
                type: "assistant" as const,
                data: Schema.encodeUnknownSync(SessionMessage.Assistant)(message),
              })),
            )
            .run()
            .pipe(Effect.orDie)
          yield* db.delete(SessionTable).where(eq(SessionTable.id, parent)).run().pipe(Effect.orDie)
          yield* artifacts.sweep()
          expect(yield* artifacts.read(ref.key)).toEqual(Uint8Array.of(42))
          yield* db
            .delete(SessionMessageTable)
            .where(eq(SessionMessageTable.session_id, child))
            .run()
            .pipe(Effect.orDie)
          yield* artifacts.settle([ref.key])
          yield* Effect.promise(() => fs.utimes(path.join(tmp.path, "blob", ref.key), new Date(0), new Date(0)))
          yield* artifacts.sweep()
          expect(Option.isNone(yield* Effect.option(artifacts.read(ref.key)))).toBe(true)
          const orphan = yield* artifacts.write({
            name: "orphan.zip",
            mime: "application/zip",
            bytes: Uint8Array.of(7),
          })
          yield* artifacts.sweep()
          expect(yield* artifacts.read(orphan.key)).toEqual(Uint8Array.of(7))
          yield* artifacts.settle([orphan.key])
          yield* Effect.promise(() => fs.utimes(path.join(tmp.path, "blob", orphan.key), new Date(0), new Date(0)))
          yield* artifacts.sweep()
          expect(Option.isNone(yield* Effect.option(artifacts.read(orphan.key)))).toBe(true)
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(LayerNode.group([SessionArtifact.node, Database.node, FSUtil.node]), [
              Global.node.replace(Global.layerWith({ data: tmp.path })),
            ]),
          ),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
