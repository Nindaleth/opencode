import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import { formatSessionCost, isDefaultTitle } from "../../src/util/session"

function session(id: string, cost: number, parentID?: string): Session {
  return {
    id,
    slug: id,
    projectID: "project",
    directory: "/tmp/project",
    title: id,
    version: "1",
    cost,
    parentID,
    time: { created: 0, updated: 0 },
  }
}

describe("util.session", () => {
  test("recognizes generated parent and child titles", () => {
    expect(isDefaultTitle("New session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("Child session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("New session - custom")).toBeFalse()
  })

  test("formats only the current session cost without descendants", () => {
    const parent = session("parent", 0.37)
    expect(formatSessionCost(parent, [parent])).toBe("$0.37")
  })

  test("formats direct descendant cost and plural task count", () => {
    const parent = session("parent", 0.37)
    const first = session("first", 0.8, parent.id)
    const second = session("second", 0.25, parent.id)
    expect(formatSessionCost(parent, [parent, first, second])).toBe("$1.42 ($0.37 + $1.05 by 2 tasks)")
  })

  test("includes nested descendants in delegated cost and task count", () => {
    const parent = session("parent", 0.37)
    const child = session("child", 0.4, parent.id)
    const grandchild = session("grandchild", 0.65, child.id)
    expect(formatSessionCost(parent, [parent, child, grandchild])).toBe("$1.42 ($0.37 + $1.05 by 2 tasks)")
  })

  test("counts zero-cost descendants and uses singular task wording", () => {
    const parent = session("parent", 0.37)
    const child = session("child", 0, parent.id)
    expect(formatSessionCost(parent, [parent, child])).toBe("$0.37 ($0.37 + $0.00 by 1 task)")
  })

  test("does not double-count a malformed cyclic tree", () => {
    const parent = session("parent", 0.37)
    const child = session("child", 0.8, parent.id)
    parent.parentID = child.id
    expect(formatSessionCost(parent, [parent, child])).toBe("$1.17 ($0.37 + $0.80 by 1 task)")
  })
})
