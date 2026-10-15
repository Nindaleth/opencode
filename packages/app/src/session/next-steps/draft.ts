import type { Prompt } from "@/composer/state"
import type { ComposerStateTarget } from "@/composer/submission-state"

/** Whether replacing the composer draft would discard anything the user entered. */
export function hasDraftContent(input: { prompt: Prompt; context: number; editing: boolean }) {
  if (input.editing || input.context > 0) return true
  return input.prompt.some((part) => part.type !== "text" || part.content.length > 0)
}

/** Replaces the whole draft with a next step as literal normal-mode text; never submits. */
export function installNextStep(
  input: {
    draft: ComposerStateTarget
    queue: { editing: () => string | undefined; cancelEdit: () => void }
    restoreFocus: (cursor: number) => void
  },
  text: string,
) {
  if (input.queue.editing()) input.queue.cancelEdit()
  input.draft.mode.set("normal")
  input.draft.context.replace([])
  input.draft.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
  input.restoreFocus(text.length)
}
