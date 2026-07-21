import { expect, test } from "bun:test"
import { formatAssistantFooterSegments, formatAssistantTokenMetadata } from "../../../src/routes/session"
import { formatSubagentFooterSegments } from "../../../src/routes/session/subagent-footer"

test("assistant footer includes message variant and token metadata when present", () => {
  expect(
    formatAssistantFooterSegments({
      mode: "build",
      model: "Claude Sonnet 4.6",
      variant: "high",
      duration: "12.0s",
      tokens: "1.2K tokens",
      throughput: "100 tk/s",
    }),
  ).toEqual(["Build", "Claude Sonnet 4.6", "high", "12.0s", "1.2K tokens", "100 tk/s"])
})

test("assistant footer omits message variant without shifting token metadata", () => {
  expect(
    formatAssistantFooterSegments({
      mode: "build",
      model: "Claude Sonnet 4.6",
      duration: "12.0s",
      tokens: "1.2K tokens",
      throughput: "100 tk/s",
    }),
  ).toEqual(["Build", "Claude Sonnet 4.6", "12.0s", "1.2K tokens", "100 tk/s"])
})

test("assistant footer keeps interrupted after token metadata", () => {
  expect(
    formatAssistantFooterSegments({
      mode: "build",
      model: "Claude Sonnet 4.6",
      duration: "12.0s",
      tokens: "1.2K tokens",
      throughput: "100 tk/s",
      interrupted: true,
    }),
  ).toEqual(["Build", "Claude Sonnet 4.6", "12.0s", "1.2K tokens", "100 tk/s", "interrupted"])
})

test("formats output tokens and assistant-only throughput", () => {
  expect(formatAssistantTokenMetadata({ output: 1200, created: 1000, completed: 13000 })).toEqual({
    tokens: "1.2K tokens",
    throughput: "100 tk/s",
  })
})

test("rounds throughput to the nearest whole token per second", () => {
  expect(formatAssistantTokenMetadata({ output: 51, created: 1000, completed: 3000 })).toEqual({
    tokens: "51 tokens",
    throughput: "26 tk/s",
  })
})

test("formats zero output tokens without throughput", () => {
  expect(formatAssistantTokenMetadata({ output: 0, created: 1000, completed: 3000 })).toEqual({
    tokens: "0 tokens",
  })
})

test("omits token metadata before completion", () => {
  expect(formatAssistantTokenMetadata({ output: 1200, created: 1000 })).toEqual({})
})

test("omits throughput for zero or negative assistant duration", () => {
  expect(formatAssistantTokenMetadata({ output: 1200, created: 1000, completed: 1000 })).toEqual({
    tokens: "1.2K tokens",
  })
  expect(formatAssistantTokenMetadata({ output: 1200, created: 1000, completed: 999 })).toEqual({
    tokens: "1.2K tokens",
  })
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
