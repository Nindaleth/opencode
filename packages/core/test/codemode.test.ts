import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Tool } from "@opencode/core/tool"
import { Session } from "@opencode/core/session"
import { Effect, Schema } from "effect"
import { it } from "./lib/effect"
import { toolIdentity } from "./lib/tool"

describe("CodeMode", () => {
  it.effect("owns registrations, execute, and catalog materialization", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* tools.transform((editor) => {
        editor.namespace({ name: "empty", description: "No tools registered yet" })
        editor.add({
          name: "echo",
          description: "Echo text",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.String,
          options: { pinned: true },
          execute: ({ text }) => Effect.succeed({ output: text }),
        })
      })

      const snapshot = yield* tools.snapshot()
      expect(snapshot.definitions.some((tool) => tool.name === "execute")).toBe(true)
      expect(snapshot.codeModeCatalog).toStrictEqual({
        tools: [
          {
            type: "tool",
            name: "echo",
            description: "Echo text",
            signature: "tools.echo({\n  text: string,\n}): Promise<string>",
            pinned: true,
          },
          {
            type: "namespace",
            name: "empty",
            description: "No tools registered yet",
            tools: [],
          },
        ],
      })
    }).pipe(
      Effect.scoped,
      Effect.provide(
        AppNodeBuilder.build(Tool.node, [
          Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
        ]),
      ),
    ),
  )

  it.effect("Code Mode dropped downloadable artifacts returned by its child tools", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* tools.transform((editor) =>
        editor.add({
          name: "binary",
          description: "Create archive",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () =>
            Effect.succeed({
              output: "created",
              content: [{ type: "text" as const, text: "Archive available for download" }],
              artifacts: [
                {
                  key: "blob_11111111-1111-4111-8111-111111111111",
                  name: "report.zip",
                  mime: "application/zip",
                  size: 3,
                },
              ],
            }),
        }),
      )
      const result = yield* (yield* tools.snapshot()).execute({
        sessionID: Session.ID.make("ses_codemode_artifact"),
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call_codemode_artifact",
          name: "execute",
          input: { code: "return await tools.binary({})" },
        },
      })
      expect(result.artifacts).toEqual([
        { key: "blob_11111111-1111-4111-8111-111111111111", name: "report.zip", mime: "application/zip", size: 3 },
      ])
      expect(JSON.stringify(result.content)).not.toContain("blob_11111111")
    }).pipe(
      Effect.scoped,
      Effect.provide(
        AppNodeBuilder.build(Tool.node, [
          Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
        ]),
      ),
    ),
  )
})
