import { describe, expect } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/core/location"
import { NotifyHttpPlugin } from "@opencode/core/plugin/notify-http"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Event } from "@opencode/schema/event"
import { Session } from "@opencode/schema/session"
import { DateTime, Effect, Queue, Stream } from "effect"
import os from "os"
import path from "path"
import { advance, drain } from "../lib/clock"
import { it } from "../lib/effect"
import { host } from "./host"

type Published = Stream.Success<ReturnType<Plugin.Context["event"]["subscribe"]>>

const directory = path.join(os.homedir(), "src", "project")
const event = (type: string, data: object) => ({ id: Event.ID.create(), created: 0, type, data }) as Published
const session = (input: {
  id: string
  title?: string
  parentID?: string
  directory?: string
  idle?: number
  viewed?: number
}) =>
  ({
    id: Session.ID.make(input.id),
    parentID: input.parentID === undefined ? undefined : Session.ID.make(input.parentID),
    title: input.title,
    location: { directory: AbsolutePath.make(input.directory ?? directory) },
    time: {
      created: DateTime.makeUnsafe(0),
      updated: DateTime.makeUnsafe(0),
      idle: input.idle === undefined ? undefined : DateTime.makeUnsafe(input.idle),
      viewed: input.viewed === undefined ? undefined : DateTime.makeUnsafe(input.viewed),
    },
  }) as Session.Info

/** Runs notify-http against a local HTTP server, scripted events and an in-memory Session table. */
const run = Effect.fnUntraced(function* (sessions: ReadonlyArray<Session.Info>, url?: string) {
  const received = new Array<{ type: string | null; summary: string | null; body: string | null }>()
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 0,
        async fetch(request) {
          const form = new URLSearchParams(await request.text())
          received.push({
            type: request.headers.get("content-type"),
            summary: form.get("summary"),
            body: form.get("body"),
          })
          return new Response("ok")
        },
      }),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  )
  const events = yield* Queue.unbounded<Published>()
  const lookups = new Array<string>()
  const table = new Map(sessions.map((item) => [item.id, item]))
  yield* NotifyHttpPlugin.configured({ url: url ?? server.url.href }).effect(
    host({
      location: new Location.Info({
        directory: AbsolutePath.make(directory),
        project: {
          id: Project.ID.global,
          directory: AbsolutePath.make(directory),
          canonical: AbsolutePath.make(directory),
        },
      }),
      event: { subscribe: () => Stream.fromQueue(events) },
      session: {
        get: (input) =>
          Effect.suspend(() => {
            lookups.push(input.sessionID)
            const found = table.get(input.sessionID)
            return found ? Effect.succeed(found) : Effect.die(new Error(`unknown session ${input.sessionID}`))
          }),
      },
    }),
  )
  return {
    received,
    lookups,
    publish: (...items: Published[]) => Queue.offerAll(events, items),
  }
})

describe("NotifyHttpPlugin", () => {
  it.effect("posts each kind of notification once", () =>
    Effect.gen(function* () {
      const test = yield* run([session({ id: "ses_main", title: "Fix the build" }), session({ id: "ses_other" })])
      yield* test.publish(
        event("session.execution.started", { sessionID: "ses_main" }),
        event("permission.asked", {
          id: "per_1",
          sessionID: "ses_main",
          action: "shell",
          resources: ["rm -rf build"],
          message: "Remove the build directory",
        }),
        event("permission.asked", { id: "per_1", sessionID: "ses_main", action: "shell", resources: [] }),
        event("form.created", { form: { id: "frm_1", sessionID: "ses_main", title: "Pick a database", fields: [] } }),
        event("form.created", { form: { id: "frm_1", sessionID: "ses_main", title: "Pick a database", fields: [] } }),
        event("session.execution.failed", {
          sessionID: "ses_main",
          error: { type: "provider.error", message: "Rate limited" },
        }),
        event("session.execution.succeeded", { sessionID: "ses_main" }),
        event("session.execution.started", { sessionID: "ses_other" }),
        event("session.execution.succeeded", { sessionID: "ses_other" }),
      )
      yield* advance(() => test.received.length === 4)
      yield* drain

      expect(test.received.map((item) => item.body).toSorted()).toEqual([
        "Input needs response: Fix the build\n\nPick a database",
        "Permission needs input: Fix the build\n\nshell\nRemove the build directory",
        "Session done: Untitled session",
        "Session failed: Fix the build\n\nRate limited",
      ])
      expect(new Set(test.received.map((item) => item.summary))).toEqual(new Set(["OpenCode: ~/src/project"]))
      expect(test.received[0]?.type).toStartWith("application/x-www-form-urlencoded")
    }),
  )

  it.effect("notifies again after a permission or form is answered and asked again", () =>
    Effect.gen(function* () {
      const test = yield* run([session({ id: "ses_main", title: "Deploy" })])
      yield* test.publish(
        event("permission.asked", { id: "per_1", sessionID: "ses_main", action: "edit", resources: [] }),
        event("permission.replied", { sessionID: "ses_main", requestID: "per_1", reply: "once" }),
        event("permission.asked", { id: "per_1", sessionID: "ses_main", action: "edit", resources: [] }),
        event("form.created", { form: { id: "frm_1", sessionID: "ses_main", title: "", fields: [] } }),
        event("form.cancelled", { id: "frm_1", sessionID: "ses_main" }),
        event("form.created", { form: { id: "frm_1", sessionID: "ses_main", title: "", fields: [] } }),
      )
      yield* advance(() => test.received.length === 4)

      expect(test.received.map((item) => item.body).toSorted()).toEqual([
        "Input needs response: Deploy",
        "Input needs response: Deploy",
        "Permission needs input: Deploy\n\nedit",
        "Permission needs input: Deploy\n\nedit",
      ])
    }),
  )

  it.effect("skips viewed, subagent, other-location and free-limit sessions", () =>
    Effect.gen(function* () {
      const test = yield* run([
        session({ id: "ses_viewed", idle: 1_000, viewed: 1_000 }),
        session({ id: "ses_child", parentID: "ses_viewed" }),
        session({ id: "ses_elsewhere", directory: path.join(os.homedir(), "src", "elsewhere") }),
        session({ id: "ses_free" }),
        session({ id: "ses_main", title: "Barrier" }),
      ])
      yield* test.publish(
        event("session.execution.succeeded", { sessionID: "ses_viewed" }),
        event("permission.asked", { id: "per_child", sessionID: "ses_child", action: "edit", resources: [] }),
        event("permission.asked", { id: "per_elsewhere", sessionID: "ses_elsewhere", action: "edit", resources: [] }),
        event("session.execution.failed", {
          sessionID: "ses_free",
          error: { type: "provider.free-limit", message: "Free limit reached" },
        }),
      )
      yield* advance(() => ["ses_viewed", "ses_child", "ses_elsewhere"].every((id) => test.lookups.includes(id)))
      yield* test.publish(
        event("permission.asked", { id: "per_main", sessionID: "ses_main", action: "edit", resources: [] }),
      )
      yield* advance(() => test.received.length > 0)
      yield* drain

      expect(test.received.map((item) => item.body)).toEqual(["Permission needs input: Barrier\n\nedit"])
    }),
  )

  it.effect("keeps notifying after the server is unreachable", () =>
    Effect.gen(function* () {
      const closed = Bun.serve({ port: 0, fetch: () => new Response("ok") })
      const url = closed.url.href
      yield* Effect.promise(() => closed.stop(true))
      const test = yield* run([session({ id: "ses_main" })], url)
      yield* test.publish(
        event("permission.asked", { id: "per_1", sessionID: "ses_main", action: "edit", resources: [] }),
        event("permission.asked", { id: "per_2", sessionID: "ses_main", action: "edit", resources: [] }),
      )
      yield* advance(() => test.lookups.length === 2)
    }),
  )

  it.effect("validates options", () =>
    Effect.sync(() => {
      expect(NotifyHttpPlugin.loadOptions({ url: "http://host:12345" })).toEqual({ url: "http://host:12345" })
      expect(NotifyHttpPlugin.loadOptions({ enabled: false })).toBeUndefined()
      expect(() => NotifyHttpPlugin.loadOptions({})).toThrow("url is required")
      expect(() => NotifyHttpPlugin.loadOptions({ url: 12345 })).toThrow()
    }),
  )
})
