export * as SessionArtifact from "./session-artifact.js"

import { Schema } from "effect"
import { NonNegativeInt } from "./schema.js"

export interface Ref extends Schema.Schema.Type<typeof Ref> {}
export const Ref = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  mime: Schema.String,
  size: NonNegativeInt,
}).annotate({ identifier: "Session.Artifact.Ref" })
