export * as McpTool from "./mcp.js"

import { ToolFailure } from "@opencode/ai/effect"
import { McpEvent } from "@opencode/schema/mcp-event"
import { Context, Effect, Fiber, type JsonSchema, Layer, Option, PubSub, Schema, Semaphore, Stream } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { extension } from "mime-types"
import { Bus } from "../bus.js"

import { Mcp } from "../mcp/index.js"
import { Mime } from "../mime.js"
import { Permission } from "../permission.js"
import { SessionArtifact } from "../session/artifact.js"
import { Tool } from "../tool.js"
import { ToolOutput } from "../tool-output.js"
import { ReadToolFileSystem } from "./read-filesystem.js"
import { effectiveName, normalizedName } from "./runtime.js"

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024
const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "application/zip": "zip",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

/**
 * Registry namespace and permission action names for MCP tools.
 */
export const namespace = (server: string) => normalizedName({ name: server })
export const name = (server: string, tool: string) =>
  effectiveName({ name: tool, options: { namespace: namespace(server) } })

export interface Interface {
  /**
   * Wait for the initial MCP tool registration, give servers still connecting a bounded chance to
   * finish, then bring the registry up to date without waiting for the debounced reload.
   */
  readonly flush: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/McpTool") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const tools = yield* Tool.Service
    const bus = yield* Bus.Service
    const permission = yield* Permission.Service
    const toolOutput = yield* ToolOutput.Service
    const artifacts = yield* SessionArtifact.Service
    const lock = Semaphore.makeUnsafe(1)
    let discovered: Mcp.Tool[] = []

    // Register once after initial discovery; only subsequent updates need a debounced reload.
    const initial = yield* lock
      .withPermit(
        Effect.gen(function* () {
          discovered = yield* mcp.tools()
          yield* tools.transform((editor) => {
            for (const tool of discovered) {
              editor.add({
                name: tool.name,
                options: { namespace: namespace(tool.server), codemode: tool.codemode !== false },
                description: tool.description ?? "",
                input: tool.inputSchema as JsonSchema.JsonSchema,
                output: (tool.outputSchema ?? {}) as JsonSchema.JsonSchema,
                execute: (input, context) =>
                  Effect.gen(function* () {
                    const args = (input ?? {}) as Record<string, unknown>
                    const resource = tool.permissionResource === undefined ? "*" : args[tool.permissionResource]
                    if (typeof resource !== "string" || resource.length === 0)
                      return yield* new ToolFailure({
                        message: `MCP tool "${name(tool.server, tool.name)}" requires a non-empty string argument "${tool.permissionResource}" for permission checks`,
                      })
                    const resources = [resource]
                    yield* permission.assert({
                      action: name(tool.server, tool.name),
                      resources,
                      save: resources,
                      metadata: { input: args },
                      ...Permission.invocation(context),
                    })
                    const result = yield* mcp
                      .callTool({
                        server: tool.server,
                        name: tool.name,
                        args,
                        sessionID: context.sessionID,
                      })
                      .pipe(
                        Effect.catchTags({
                          "MCP.NotFoundError": (error) =>
                            new ToolFailure({ message: `MCP server "${error.server}" is not available` }),
                          "MCP.ToolCallError": (error) => new ToolFailure({ message: error.message }),
                        }),
                      )
                    if (result.isError)
                      return yield* new ToolFailure({
                        message:
                          result.content
                            .flatMap((part) => (part.type === "text" ? [part.text] : []))
                            .join("\n")
                            .trim() || "MCP tool returned an error",
                      })
                    const refs: SessionArtifact.Ref[] = []
                    const content = yield* Effect.forEach(result.content, (part) =>
                      Effect.gen(function* () {
                        if (part.type === "text") return { type: "text" as const, text: part.text }
                        const mime = /^[\w.+-]+\/[\w.+-]+$/.test(part.mimeType)
                          ? part.mimeType
                          : "application/octet-stream"
                        const filename =
                          (
                            part.name ||
                            part.uri?.split("/").pop() ||
                            `artifact-${refs.length + 1}.${EXTENSIONS[mime] ?? "bin"}`
                          )
                            .replaceAll("\\", "/")
                            .split("/")
                            .pop()!
                            .replace(/[\x00-\x1f\x7f"\\]/g, "_")
                            .replace(/\.{2,}/g, ".")
                            .trim() || `artifact-${refs.length + 1}.bin`
                        const data = part.data
                        if (
                          data.length > Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4 + 4 ||
                          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
                        )
                          return {
                            type: "text" as const,
                            text: `[Binary MCP attachment ${filename} omitted: invalid or exceeds 10 MB]`,
                          }
                        const bytes = Uint8Array.fromBase64(data)
                        if (bytes.byteLength > MAX_ARTIFACT_BYTES)
                          return {
                            type: "text" as const,
                            text: `[Binary MCP attachment ${filename} omitted: exceeds 10 MB]`,
                          }
                        const stored = yield* artifacts.write(context.sessionID, { name: filename, mime, bytes }).pipe(
                          Effect.tap((ref) =>
                            Effect.sync(() => {
                              refs.push(ref)
                            }),
                          ),
                          Effect.option,
                        )
                        if (stored._tag === "None")
                          return {
                            type: "text" as const,
                            text: `[Binary MCP attachment ${filename} could not be saved]`,
                          }
                        return yield* toContent(
                          { ...part, mimeType: mime, ...(part.name === undefined ? {} : { name: filename }) },
                          toolOutput,
                        )
                      }),
                    )
                    const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
                    const output = () => {
                      if (result.structured !== undefined) return result.structured
                      if (text === "") return null
                      // Agents assume JSON returned as text is already an object, so parse it when the server declares no schema.
                      if (tool.outputSchema === undefined && (text.startsWith("{") || text.startsWith("[")))
                        return Option.getOrElse(decodeJson(text), () => text)
                      return text
                    }
                    return {
                      output: output(),
                      ...(content.length === 0 ? {} : { content }),
                      ...(refs.length === 0 ? {} : { artifacts: refs }),
                    }
                  }).pipe(
                    Effect.mapError((error) => {
                      if (error instanceof ToolFailure) return error
                      if (error instanceof Permission.BlockedError)
                        return new ToolFailure({ message: error.message, error })
                      if (error instanceof Permission.CorrectedError)
                        return new ToolFailure({ message: error.feedback, error })
                      return new ToolFailure({ message: `Unable to execute ${name(tool.server, tool.name)}`, error })
                    }),
                  ),
              })
            }
          })
        }),
      )
      .pipe(Effect.forkScoped)
    const reconcile = lock.withPermit(
      Effect.gen(function* () {
        discovered = yield* mcp.tools()
        yield* tools.reload()
      }),
    )

    // Servers announce tools in bursts and each read loads the whole catalog, so settle and refresh
    // once. The bus subscription stays eager; only the already-open sliding subscription is debounced.
    const changes = yield* PubSub.sliding<void>(1)
    yield* bus.subscribe(McpEvent.ToolsChanged).pipe(
      Stream.runForEach(() => PubSub.publish(changes, undefined)),
      Effect.forkScoped({ startImmediately: true }),
    )
    const updates = yield* PubSub.subscribe(changes)
    yield* Stream.fromSubscription(updates).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() => reconcile),
      Effect.forkScoped({ startImmediately: true }),
    )
    return Service.of({
      flush: Effect.gen(function* () {
        yield* Fiber.await(initial)
        yield* mcp.awaitStartup()
        // Each catalog refresh creates new tool objects, so identity shows whether the registry is behind.
        const current = yield* mcp.tools()
        if (current.length !== discovered.length || current.some((tool, index) => tool !== discovered[index]))
          yield* reconcile
      }),
    })
  }),
)

// Only media the read tool also accepts is sent inline; other types would fail request lowering on every later turn.
const toContent = Effect.fnUntraced(function* (part: Mcp.ToolResultContent, toolOutput: ToolOutput.Interface) {
  if (part.type === "text") return { type: "text" as const, text: part.text }
  const mime = part.mimeType.split(";", 1)[0].trim().toLowerCase()
  if (ReadToolFileSystem.MEDIA_MIMES.has(mime))
    return {
      type: "file" as const,
      uri: `data:${part.mimeType};base64,${part.data}`,
      mime: part.mimeType,
      ...(part.name === undefined ? {} : { name: part.name }),
    }
  const bytes = Buffer.from(part.data, "base64")
  const label = part.name ?? part.uri ?? "content"
  if (Mime.isTextual(mime))
    return { type: "text" as const, text: `[Resource ${label} (${part.mimeType})]\n${bytes.toString("utf8")}` }
  const ext = extension(mime)
  const file = yield* toolOutput.save(bytes, ext ? `.${ext}` : "")
  return {
    type: "text" as const,
    text: `[Binary resource ${label} (${part.mimeType}, ${bytes.byteLength} bytes) saved to ${file}]`,
  }
})

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Tool.node, Mcp.node, Bus.node, Permission.node, ToolOutput.node, SessionArtifact.node],
})
