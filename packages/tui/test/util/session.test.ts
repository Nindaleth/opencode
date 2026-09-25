import { describe, expect, test } from "bun:test"
import { formatSessionCost, sessionFamily } from "../../src/util/session"

describe("util.session", () => {
  test("shows only the local cost when a session has no descendants", () => {
    expect(formatSessionCost({ id: "root", cost: 0.37 }, [{ id: "root", cost: 0.37 }])).toBe("$0.37")
  })

  test("counts direct and nested tasks, including zero-cost tasks", () => {
    const root = { id: "root", cost: 0.37 }
    expect(
      formatSessionCost(root, [
        root,
        { id: "child-a", parentID: "root", cost: 0.4 },
        { id: "child-b", parentID: "root", cost: 0.65 },
      ]),
    ).toBe("$1.42 ($0.37 + $1.05 by 2 tasks)")
    expect(
      formatSessionCost(root, [
        root,
        { id: "child-a", parentID: "root", cost: 0.4 },
        { id: "grandchild", parentID: "child-a", cost: 0.65 },
        { id: "child-b", parentID: "root", cost: 0 },
      ]),
    ).toBe("$1.42 ($0.37 + $1.05 by 3 tasks)")
  })

  test("shows a zero-cost task even when the parent has no spend", () => {
    const root = { id: "root", cost: 0 }
    expect(formatSessionCost(root, [root, { id: "child", parentID: "root", cost: 0 }])).toBe(
      "$0.00 ($0.00 + $0.00 by 1 task)",
    )
  })

  test("excludes unrelated sessions and ancestors when viewing a child", () => {
    const child = { id: "child", parentID: "root", cost: 0.2 }
    expect(
      formatSessionCost(child, [
        { id: "root", cost: 2 },
        child,
        { id: "grandchild", parentID: "child", cost: 0.3 },
        { id: "sibling", parentID: "root", cost: 4 },
        { id: "unrelated", cost: 8 },
      ]),
    ).toBe("$0.50 ($0.20 + $0.30 by 1 task)")
  })

  test("does not revisit repeated IDs or cycles", () => {
    const root = { id: "root", parentID: "child", cost: 0.37 }
    expect(
      formatSessionCost(root, [
        root,
        { id: "child", parentID: "root", cost: 0.4 },
        { id: "child", parentID: "root", cost: 0.4 },
      ]),
    ).toBe("$0.77 ($0.37 + $0.40 by 1 task)")
  })

  test("flattens nested subagents from any session in the family", () => {
    const sessions = [
      { id: "root" },
      { id: "child-a", parentID: "root" },
      { id: "grandchild-a", parentID: "child-a" },
      { id: "great-grandchild-a", parentID: "grandchild-a" },
      { id: "grandchild-a2", parentID: "child-a" },
      { id: "child-b", parentID: "root" },
      { id: "grandchild-b", parentID: "child-b" },
    ]

    expect(sessionFamily(sessions, "great-grandchild-a")).toEqual([
      { session: sessions[1], prefix: "" },
      { session: sessions[2], prefix: "├─ " },
      { session: sessions[3], prefix: "│  └─ " },
      { session: sessions[4], prefix: "└─ " },
      { session: sessions[5], prefix: "" },
      { session: sessions[6], prefix: "└─ " },
    ])
  })
})
