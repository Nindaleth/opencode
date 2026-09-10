type ToolPart = {
  tool: string
  state: unknown
}

export function bashOutput(part: ToolPart) {
  if (typeof part.state !== "object" || part.state === null) return
  const state = part.state as Record<string, unknown>
  if (typeof state.output === "string") return state.output
  if (part.tool !== "bash" || state.status !== "completed" || !Array.isArray(state.content)) return

  return state.content
    .flatMap((content) => {
      if (typeof content !== "object" || content === null) return []
      const value = content as Record<string, unknown>
      if (value.type !== "text" || typeof value.text !== "string") return []
      return [value.text]
    })
    .join("\n")
}
