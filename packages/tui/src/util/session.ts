import type { Session } from "@opencode-ai/sdk/v2"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export function isDefaultTitle(title: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}

export function formatSessionCost(session: Session, sessions: ReadonlyArray<Session>) {
  const children = new Map<string, Session[]>()
  for (const item of sessions) {
    if (!item.parentID) continue
    const current = children.get(item.parentID) ?? []
    current.push(item)
    children.set(item.parentID, current)
  }

  const visited = new Set([session.id])
  const descendants: Session[] = []
  const pending = [...(children.get(session.id) ?? [])]
  for (const item of pending) {
    if (visited.has(item.id)) continue
    visited.add(item.id)
    descendants.push(item)
    pending.push(...(children.get(item.id) ?? []))
  }

  const own = session.cost ?? 0
  if (descendants.length === 0) return money.format(own)

  const delegated = descendants.reduce((total, item) => total + (item.cost ?? 0), 0)
  const task = descendants.length === 1 ? "task" : "tasks"
  return `${money.format(own + delegated)} (${money.format(own)} + ${money.format(delegated)} by ${descendants.length} ${task})`
}
