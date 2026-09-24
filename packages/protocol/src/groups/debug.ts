import { Location } from "@opencode/schema/location"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location.js"
import { InvalidRequestError } from "../errors.js"

export const makeDebugGroup = <LocationId extends HttpApiMiddleware.AnyId, LocationService>(
  locationMiddleware: Context.Key<LocationId, LocationService>,
) =>
  HttpApiGroup.make("server.debug")
    .add(
      HttpApiEndpoint.get("debug.prompt", "/api/debug/prompt", {
        query: Schema.Struct({
          ...LocationQuery.fields,
          provider: Schema.optional(Schema.String),
          model: Schema.optional(Schema.String),
          agent: Schema.optional(Schema.String),
        }),
        success: Schema.Struct({
          selection: Schema.Struct({ provider: Schema.String, model: Schema.String, agent: Schema.String }),
          system: Schema.Array(Schema.String),
          tools: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
        }),
        error: InvalidRequestError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "debug.prompt",
            summary: "Preview effective model prompt",
            description: "Preview the initial model request without creating a session or calling a model.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("debug.location", "/api/debug/location", {
        success: Schema.Array(Location.PublicRef),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "debug.location.list",
          summary: "List loaded locations",
          description: "List locations currently loaded by the server.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("debug.location.evict", "/api/debug/location", {
        query: LocationQuery,
        success: HttpApiSchema.NoContent,
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "debug.location.evict",
            summary: "Evict a loaded location",
            description: "Dispose the requested location's cached services so its next use boots them fresh.",
          }),
        ),
    )
    .annotateMerge(OpenApi.annotations({ title: "debug" }))
