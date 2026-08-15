import { Config } from "@/config/config"
import { InstanceStore } from "@/project/instance-store"
import { SessionStatus } from "@/session/status"
import { errorMessage } from "@/util/error"
import { Cause, Effect } from "effect"

export type Result = { ok: true } | { ok: false; message: string }

export const reload = Effect.fn("TuiReload.reload")(
  function* (directory: string) {
    const config = yield* Config.Service
    const instances = yield* InstanceStore.Service
    const status = yield* SessionStatus.Service
    const active = yield* instances.provide({ directory }, status.list())
    if (active.size > 0) {
      return { ok: false, message: "Cannot reload while a session is busy or retrying." } as const
    }

    yield* config.invalidate()
    yield* instances.reload({ directory })
    return { ok: true } as const
  },
  Effect.catchCause((cause) => Effect.succeed({ ok: false, message: errorMessage(Cause.squash(cause)) } as const)),
)

export * as TuiReload from "./reload"
