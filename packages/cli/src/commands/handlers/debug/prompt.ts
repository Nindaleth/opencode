import { EOL } from "os"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServerConnection } from "../../../services/server-connection"

export default Runtime.handler(
  Commands.commands.debug.commands.prompt,
  Effect.fn("cli.debug.prompt")(function* (input) {
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    })
    const client = OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
    const response = yield* Effect.promise(() =>
      client.debug.prompt({
        location: { directory: process.cwd() },
        provider: Option.getOrUndefined(input.provider),
        model: Option.getOrUndefined(input.model),
        agent: Option.getOrUndefined(input.agent),
      }),
    )
    process.stdout.write(JSON.stringify(response, null, 2) + EOL)
  }),
)
