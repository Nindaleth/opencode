export * as NotifyHttpPlugin from "./notify-http.js"

import type { Plugin } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { DateTime, Effect, Schema, Stream } from "effect"
import os from "os"
import path from "path"

const Options = Schema.Struct({
  url: Schema.optionalKey(Schema.String),
  enabled: Schema.optionalKey(Schema.Boolean),
})

export function loadOptions(options: Record<string, unknown>) {
  const parsed = Schema.decodeUnknownSync(Options)(options)
  if (parsed.enabled === false) return undefined
  if (!parsed.url) throw new Error("Invalid notify-http options: url is required unless enabled is false")
  return { url: parsed.url }
}

export function configured(options: Record<string, unknown>): Plugin {
  return {
    id: "notify-http",
    effect: (ctx) =>
      Effect.gen(function* () {
        const config = loadOptions(options)
        if (!config) return
        const forms = new Set<string>()
        const permissions = new Set<string>()
        const terminal = new Set<string>()

        const notify = (input: { sessionID: string; event: string; detail?: string; unlessViewed?: boolean }) =>
          Effect.gen(function* () {
            // A focused TUI marks the Session viewed shortly after it goes idle.
            if (input.unlessViewed) yield* Effect.sleep("2 seconds")
            const session = yield* ctx.session.get({ sessionID: Session.ID.make(input.sessionID) })
            if (session.parentID) return
            if (session.location.directory !== ctx.location.directory) return
            if (input.unlessViewed && viewed(session)) return
            yield* send(config.url, {
              summary: `OpenCode: ${displayPath(session.location.directory)}`,
              body: [`${input.event}: ${session.title || "Untitled session"}`, input.detail]
                .filter((part) => part)
                .join("\n\n"),
            })
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to send notification", { sessionID: input.sessionID, cause }),
            ),
            Effect.forkScoped,
          )

        yield* ctx.event.subscribe().pipe(
          Stream.runForEach((event) => {
            switch (event.type) {
              case "session.execution.started":
                terminal.delete(event.data.sessionID)
                return Effect.void
              case "session.execution.succeeded":
              case "session.execution.interrupted":
                if (terminal.has(event.data.sessionID)) return Effect.void
                terminal.add(event.data.sessionID)
                return notify({ sessionID: event.data.sessionID, event: "Session done", unlessViewed: true })
              case "session.execution.failed":
                if (terminal.has(event.data.sessionID)) return Effect.void
                terminal.add(event.data.sessionID)
                if (event.data.error.type === "provider.free-limit") return Effect.void
                return notify({
                  sessionID: event.data.sessionID,
                  event: "Session failed",
                  detail: event.data.error.message,
                })
              case "form.created":
                if (forms.has(event.data.form.id)) return Effect.void
                forms.add(event.data.form.id)
                return notify({
                  sessionID: event.data.form.sessionID,
                  event: "Input needs response",
                  detail: event.data.form.title,
                })
              case "form.replied":
              case "form.cancelled":
                forms.delete(event.data.id)
                return Effect.void
              case "permission.asked":
                if (permissions.has(event.data.id)) return Effect.void
                permissions.add(event.data.id)
                return notify({
                  sessionID: event.data.sessionID,
                  event: "Permission needs input",
                  detail: [event.data.action, event.data.message].filter((part) => part).join("\n"),
                })
              case "permission.replied":
                permissions.delete(event.data.requestID)
                return Effect.void
              default:
                return Effect.void
            }
          }),
          Effect.forkScoped({ startImmediately: true }),
        )
      }),
  }
}

function viewed(session: Session.Info) {
  if (!session.time.idle || !session.time.viewed) return false
  return DateTime.isGreaterThanOrEqualTo(session.time.viewed, session.time.idle)
}

function displayPath(directory: string) {
  const home = os.homedir()
  if (directory === home) return "~"
  if (directory.startsWith(home + path.sep)) return "~" + directory.slice(home.length)
  return directory
}

function send(url: string, fields: { summary: string; body: string }) {
  return Effect.tryPromise((signal) => fetch(url, { method: "POST", body: new URLSearchParams(fields), signal })).pipe(
    Effect.flatMap((response) =>
      response.ok ? Effect.void : Effect.fail(new Error(`notify-http server replied with HTTP ${response.status}`)),
    ),
    Effect.timeout("5 seconds"),
  )
}
