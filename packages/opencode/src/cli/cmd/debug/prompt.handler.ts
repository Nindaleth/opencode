import { EOL } from "node:os"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import type { AppServices } from "@/effect/app-runtime"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { fail, type CliError } from "@/cli/effect-cmd"
import { Instruction } from "@/session/instruction"
import { LLMRequestPrep } from "@/session/llm/request"
import { SessionProcessor } from "@/session/processor"
import { SessionID, MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { SystemPrompt } from "@/session/system"
import { SessionTools } from "@/session/tools"
import type { TaskPromptOps } from "@/tool/task"
import { Provider } from "@/provider/provider"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"

export const debugPrompt = (args: {
  provider?: string
  model?: string
  agent?: string
}): Effect.Effect<void, CliError, AppServices> =>
  Effect.gen(function* () {
    if (!!args.provider !== !!args.model) return yield* fail("--provider and --model must be used together")

    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const systemPrompt = yield* SystemPrompt.Service
    const instruction = yield* Instruction.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const agent = args.agent ? yield* agents.get(args.agent) : yield* agents.defaultInfo()
    if (!agent) {
      const available = (yield* agents.list()).filter((agent) => !agent.hidden).map((agent) => agent.name)
      const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
      return yield* fail(`Agent not found: "${args.agent}".${hint}`)
    }

    const selected = args.provider
      ? {
          providerID: ProviderV2.ID.make(args.provider),
          modelID: ModelV2.ID.make(args.model!),
        }
      : (agent.model ?? (yield* provider.defaultModel().pipe(Effect.orDie)))
    const model = yield* provider.getModel(selected.providerID, selected.modelID).pipe(Effect.orDie)
    const same = agent.model && model.providerID === agent.model.providerID && model.id === agent.model.modelID
    const variant = same && agent.variant && model.variants?.[agent.variant] ? agent.variant : undefined
    const sessionID = SessionID.make("ses_debug_prompt")
    const user: SessionV1.User = {
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: agent.name,
      model: { providerID: model.providerID, modelID: model.id, variant },
    }
    const session: Session.Info = {
      id: sessionID,
      slug: "debug-prompt",
      projectID: ProjectV2.ID.make("debug-prompt"),
      directory: process.cwd(),
      title: "Debug prompt",
      version: "debug",
      time: { created: user.time.created, updated: user.time.created },
    }
    const processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall"> = {
      message: {
        id: MessageID.ascending(),
        sessionID,
        role: "assistant",
        time: { created: user.time.created },
        parentID: user.id,
        modelID: model.id,
        providerID: model.providerID,
        agent: agent.name,
        mode: agent.mode,
        path: { cwd: process.cwd(), root: process.cwd() },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      updateToolCall: () => Effect.die("tool execution is not available in debug prompt"),
      completeToolCall: () => Effect.die("tool execution is not available in debug prompt"),
    }
    const promptOps: TaskPromptOps = {
      cancel: () => Effect.die("tool execution is not available in debug prompt"),
      resolvePromptParts: () => Effect.die("tool execution is not available in debug prompt"),
      prompt: () => Effect.die("tool execution is not available in debug prompt"),
    }
    const [skills, env, instructions, mcpInstructions] = yield* Effect.all([
      systemPrompt.skills(agent),
      systemPrompt.environment(model),
      instruction.system().pipe(Effect.orDie),
      systemPrompt.mcp(agent),
    ])
    const system = [...env, ...instructions, ...(mcpInstructions ? [mcpInstructions] : []), ...(skills ? [skills] : [])]
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps,
    })
    const prepared = yield* LLMRequestPrep.prepare({
      user,
      sessionID,
      model,
      agent,
      system,
      messages: [],
      tools,
      provider: yield* provider.getProvider(model.providerID),
      auth: yield* auth.get(model.providerID).pipe(Effect.orDie),
      plugin,
      flags,
      isWorkflow: false,
    })
    const serializableTools = Object.fromEntries(
      Object.entries(prepared.tools).map(([name, tool]) => [
        name,
        Object.fromEntries(Object.entries(tool).filter(([, value]) => typeof value !== "function")),
      ]),
    )
    process.stdout.write(
      JSON.stringify(
        {
          ...prepared,
          tools: serializableTools,
          selection: { provider: model.providerID, model: model.id, agent: agent.name },
        },
        null,
        2,
      ) + EOL,
    )
  }) as Effect.Effect<void, CliError, AppServices>

export * as DebugPrompt from "./prompt.handler"
