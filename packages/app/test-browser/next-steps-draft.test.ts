import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createMemoryComposerState } from "@/composer/state"
import { installNextStep } from "@/session/next-steps/draft"

function setup(editing?: string) {
  return createRoot((dispose) => {
    const draft = createMemoryComposerState()
    const focus: number[] = []
    const queue = {
      id: editing,
      editing: () => queue.id,
      cancelEdit: () => {
        if (!queue.id) return
        queue.id = undefined
        draft.mode.set("shell")
        draft.set([{ type: "text", content: "stashed draft", start: 0, end: 13 }], 13)
      },
    }

    return { draft, queue, focus, dispose, restoreFocus: (cursor: number) => focus.push(cursor) }
  })
}

test("replaces the whole draft with the literal next step in normal mode", () => {
  const value = setup()
  value.draft.mode.set("shell")
  value.draft.set(
    [
      { type: "text", content: "old draft", start: 0, end: 9 },
      { type: "path", id: "att_1", filename: "log.txt", mime: "text/plain", path: "/tmp/log.txt" },
    ],
    9,
  )
  value.draft.context.add({ type: "file", path: "src/queue.ts" })

  installNextStep({ draft: value.draft, queue: value.queue, restoreFocus: value.restoreFocus }, "/review the diff")

  expect(value.draft.current()).toEqual([{ type: "text", content: "/review the diff", start: 0, end: 16 }])
  expect(value.draft.cursor()).toBe(16)
  expect(value.draft.mode.current()).toBe("normal")
  expect(value.draft.context.items()).toEqual([])
  expect(value.focus).toEqual([16])
  value.dispose()
})

test("leaves queue edit before installing the next step", () => {
  const value = setup("inb_1")

  installNextStep({ draft: value.draft, queue: value.queue, restoreFocus: value.restoreFocus }, "Run the tests")

  expect(value.queue.editing()).toBeUndefined()
  expect(value.draft.current()).toEqual([{ type: "text", content: "Run the tests", start: 0, end: 13 }])
  expect(value.draft.mode.current()).toBe("normal")
  value.dispose()
})
