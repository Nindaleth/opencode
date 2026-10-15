import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createNextSteps } from "@/session/next-steps/controller"
import type { NextStepsTarget } from "@/session/next-steps/target"

const first = { sessionID: "ses_1", messageID: "msg_reply", idleID: "msg_idle" }
const second = { sessionID: "ses_1", messageID: "msg_reply_2", idleID: "msg_idle_2" }

function setup(initial: { target?: NextStepsTarget; enabled?: boolean } = {}) {
  const calls: {
    target: NextStepsTarget
    signal: AbortSignal
    resolve: (items: readonly string[]) => void
    reject: () => void
  }[] = []
  return createRoot((dispose) => {
    const [target, setTarget] = createSignal(initial.target)
    const [enabled, setEnabled] = createSignal(initial.enabled ?? true)
    const steps = createNextSteps({
      target,
      enabled,
      request: (target, signal) =>
        new Promise<readonly string[]>((resolve, reject) => {
          calls.push({ target, signal, resolve, reject: () => reject(new Error("offline")) })
        }),
    })
    return { calls, steps, setTarget, setEnabled, dispose }
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("createNextSteps", () => {
  test("requests once per target", async () => {
    const owned = setup({ target: first })
    expect(owned.calls.map((call) => call.target)).toEqual([first])

    owned.calls[0]!.resolve(["Run the tests"])
    await settle()
    expect(owned.steps.items("msg_reply")).toEqual(["Run the tests"])
    expect(owned.steps.items("msg_other")).toEqual([])

    owned.setTarget({ ...first })
    await settle()
    expect(owned.calls).toHaveLength(1)
    expect(owned.steps.items("msg_reply")).toEqual(["Run the tests"])
    owned.dispose()
  })

  test("aborts and clears when the target changes", async () => {
    const owned = setup({ target: first })
    owned.setTarget(second)
    expect(owned.calls[0]!.signal.aborted).toBe(true)
    expect(owned.calls.map((call) => call.target)).toEqual([first, second])

    owned.calls[0]!.resolve(["Stale step"])
    await settle()
    expect(owned.steps.items("msg_reply")).toEqual([])
    expect(owned.steps.items("msg_reply_2")).toEqual([])

    owned.calls[1]!.resolve(["Fresh step"])
    await settle()
    expect(owned.steps.items("msg_reply_2")).toEqual(["Fresh step"])

    owned.setTarget(undefined)
    expect(owned.calls[1]!.signal.aborted).toBe(true)
    expect(owned.steps.items("msg_reply_2")).toEqual([])
    owned.dispose()
  })

  test("does not request while disabled and aborts when disabled", async () => {
    const off = setup({ target: first, enabled: false })
    expect(off.calls).toHaveLength(0)
    off.dispose()

    const owned = setup({ target: first })
    owned.calls[0]!.resolve(["Run the tests"])
    await settle()
    owned.setEnabled(false)
    expect(owned.steps.items("msg_reply")).toEqual([])

    owned.setTarget(second)
    expect(owned.calls).toHaveLength(1)
    owned.setTarget(first)
    owned.setEnabled(true)
    owned.setEnabled(false)
    expect(owned.calls[1]!.signal.aborted).toBe(true)
    owned.calls[1]!.resolve(["Late step"])
    await settle()
    expect(owned.steps.items("msg_reply")).toEqual([])
    owned.dispose()
  })

  // Hiding and showing the conversation on mobile made a new model call for the same reply.
  test("reuses the result when the same target returns", async () => {
    const owned = setup({ target: first })
    owned.calls[0]!.resolve(["Run the tests"])
    await settle()
    owned.setTarget(undefined)
    expect(owned.steps.items("msg_reply")).toEqual([])
    owned.setTarget(first)
    expect(owned.calls).toHaveLength(1)
    expect(owned.steps.items("msg_reply")).toEqual(["Run the tests"])
    owned.dispose()
  })

  test("requests again when re-enabled", async () => {
    const owned = setup({ target: first })
    owned.calls[0]!.resolve(["Run the tests"])
    await settle()
    owned.setEnabled(false)
    owned.setEnabled(true)
    expect(owned.calls.map((call) => call.target)).toEqual([first, first])
    owned.calls[1]!.resolve(["Check the logs"])
    await settle()
    expect(owned.steps.items("msg_reply")).toEqual(["Check the logs"])
    owned.dispose()
  })

  test("shows nothing when the request fails", async () => {
    const owned = setup({ target: first })
    owned.calls[0]!.reject()
    await settle()
    expect(owned.steps.items("msg_reply")).toEqual([])
    expect(owned.steps.target()).toEqual(first)
    owned.dispose()
  })

  test("aborts the pending request on cleanup", () => {
    const owned = setup({ target: first })
    owned.dispose()
    expect(owned.calls[0]!.signal.aborted).toBe(true)
  })
})
