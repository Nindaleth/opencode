import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Effect, Option, RcMap } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { requestRef } from "../location"
import { SessionPromptPreview } from "@opencode/core/session/prompt-preview"
import { InvalidRequestError } from "@opencode/protocol/errors"

export const DebugHandler = HttpApiBuilder.group(Api, "server.debug", (handlers) =>
  handlers
    .handle(
      "debug.prompt",
      Effect.fn(function* (ctx) {
        const preview = yield* SessionPromptPreview.Service
        return yield* preview
          .prepare(ctx.query)
          .pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message })))
      }),
    )
    .handle(
      "debug.location",
      Effect.fn(function* () {
        const locations = Option.getOrThrow(yield* Effect.serviceOption(LocationServiceMap.Service))
        return Array.from(yield* RcMap.keys(locations.rcMap))
      }),
    )
    .handle(
      "debug.location.evict",
      Effect.fn(function* (ctx) {
        const locations = Option.getOrThrow(yield* Effect.serviceOption(LocationServiceMap.Service))
        // Resolve through requestRef so the key matches the shape the location
        // middleware cached the services under.
        yield* locations.invalidate(requestRef(ctx.request))
      }),
    ),
)
