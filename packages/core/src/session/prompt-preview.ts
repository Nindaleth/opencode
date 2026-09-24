export * as SessionPromptPreview from "./prompt-preview.js"

import { Money } from "@opencode/schema/money"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Agent } from "../agent.js"
import { Instructions } from "../instructions/index.js"
import { Location } from "../location.js"
import { Model } from "../model.js"
import { Provider } from "../provider.js"
import { Plugin } from "../plugin.js"
import { SessionContext } from "./context.js"
import { SessionModelRequest } from "./model-request.js"
import { SessionSchema } from "./schema.js"

export class SelectionError extends Schema.TaggedError<SelectionError>()("SessionPromptPreview.SelectionError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly prepare: (input: {
    readonly provider?: string
    readonly model?: string
    readonly agent?: string
  }) => Effect.Effect<
    {
      selection: { provider: string; model: string; agent: string }
      system: string[]
      tools: { name: string; description: string }[]
    },
    SelectionError
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPromptPreview") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const context = yield* SessionContext.Service
    const location = yield* Location.Service
    const agents = yield* Agent.Service
    const plugins = yield* Plugin.Service
    const prepare = Effect.fn("SessionPromptPreview.prepare")(function* (input: Parameters<Interface["prepare"]>[0]) {
      yield* plugins.awaitActivation
      if ((input.provider === undefined) !== (input.model === undefined))
        return yield* new SelectionError({ message: "Specify --provider and --model together" })
      const agent = yield* agents.select(input.agent)
      if (!agent.info) return yield* new SelectionError({ message: `Agent not found: ${input.agent ?? agent.id}` })
      const ref =
        input.provider !== undefined && input.model !== undefined
          ? Model.Ref.make({ providerID: Provider.ID.make(input.provider), id: Model.ID.make(input.model) })
          : undefined
      const session = SessionSchema.Info.make({
        id: SessionSchema.ID.create(),
        projectID: location.project.id,
        location: Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
        ...(ref ? { model: ref } : {}),
        agent: agent.id,
        cost: Money.USD.zero,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
      })
      const selection = yield* context.selectTransient(session).pipe(Effect.orDie)
      const model = yield* context
        .resolveModel(session)
        .pipe(Effect.mapError((error) => new SelectionError({ message: error.message })))
      const observed = yield* Instructions.read(selection.instructions)
      const values = Object.fromEntries(
        observed.flatMap(({ key, value }) =>
          value === Instructions.unavailable || value === Instructions.removed ? [] : [[key, value]],
        ),
      )
      const transcript = SessionModelRequest.baseTranscript({
        agent: selection.agent.info,
        model,
        tools: selection.tools,
        initial: Instructions.renderInitial(selection.instructions, values),
        messages: [],
      })
      const prepared = yield* context.request.primary({
        session,
        agent: agent.id,
        model,
        tools: selection.tools,
        system: transcript.system,
        messages: transcript.messages,
        preview: true,
      })
      return {
        selection: { provider: model.ref.providerID, model: model.ref.id, agent: agent.id },
        system: prepared.request.system.map((part) => part.text),
        tools: prepared.request.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "" })),
      }
    })
    return Service.of({ prepare })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [SessionContext.node, Location.node, Agent.node, Plugin.node],
})
