import { createEffect, createMemo, on, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { NextStepsTarget } from "./target"

/** Requests next steps once per eligible target while enabled and exposes the results for that target's reply. */
export function createNextSteps(input: {
  target: Accessor<NextStepsTarget | undefined>
  enabled: Accessor<boolean>
  request: (target: NextStepsTarget, signal: AbortSignal) => Promise<readonly string[]>
}) {
  const [store, setStore] = createStore<{ key?: string; messageID?: string; items: readonly string[]; done: boolean }>({
    items: [],
    done: false,
  })
  const target = createMemo(() => (input.enabled() ? input.target() : undefined))
  const key = createMemo(() => {
    const current = target()
    return current && `${current.sessionID}:${current.messageID}:${current.idleID}`
  })
  // Holds the abort handle of the single in-flight request.
  let pending: AbortController | undefined

  createEffect(
    on(key, (key) => {
      pending?.abort()
      pending = undefined
      const current = target()
      // A target that only became ineligible for a while, such as a hidden view, keeps its result.
      if (!key && input.enabled()) return
      if (key && key === store.key && store.done) return
      setStore({ key, messageID: current?.messageID, items: [], done: false })
      if (!key || !current) return
      const controller = new AbortController()
      pending = controller
      input
        .request(current, controller.signal)
        .then((items) => {
          if (controller.signal.aborted || store.key !== key) return
          setStore({ items, done: true })
        })
        .catch(() => undefined)
    }),
  )

  onCleanup(() => pending?.abort())

  return {
    target,
    items: (messageID: string) => (key() && key() === store.key && store.messageID === messageID ? store.items : []),
  }
}
