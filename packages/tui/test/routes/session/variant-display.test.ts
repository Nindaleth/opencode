import { expect, test } from "bun:test"
import { formatAssistantFooterSegments } from "../../../src/routes/session"
import { formatSubagentFooterSegments } from "../../../src/routes/session/subagent-footer"

test("assistant footer includes message variant when present", () => {
  expect(
    formatAssistantFooterSegments({ mode: "build", model: "Claude Sonnet 4.6", variant: "high", duration: "12s" }),
  ).toEqual(["Build", "Claude Sonnet 4.6", "high", "12s"])
})

test("assistant footer omits message variant when unset", () => {
  expect(formatAssistantFooterSegments({ mode: "build", model: "Claude Sonnet 4.6", duration: "12s" })).toEqual([
    "Build",
    "Claude Sonnet 4.6",
    "12s",
  ])
})

test("subagent footer includes session variant when present", () => {
  expect(formatSubagentFooterSegments({ label: "Explore", count: "2 of 4", variant: "high" })).toEqual([
    "Explore",
    "2 of 4",
    "high",
  ])
})

test("subagent footer omits session variant when unset", () => {
  expect(formatSubagentFooterSegments({ label: "Explore", count: "2 of 4" })).toEqual(["Explore", "2 of 4"])
})
