import { expect, test } from "bun:test"
import { permissionPresentation } from "../../src/util/permission"

test("preserves permission roots and self-contained metadata", () => {
  expect(permissionPresentation({ action: "external_directory", resources: ["/*"] }).title).toBe(
    "Access external directory /",
  )
  expect(permissionPresentation({ action: "external_directory", resources: ["C:/*"] }).title).toBe(
    "Access external directory C:/",
  )
  expect(
    permissionPresentation({ action: "webfetch", resources: [], metadata: { url: "https://example.com" } }),
  ).toMatchObject({
    title: "WebFetch https://example.com",
    lines: ["URL: https://example.com"],
  })
  expect(permissionPresentation({ action: "websearch", resources: [], metadata: { query: "releases" } })).toMatchObject(
    {
      title: 'Web Search "releases"',
      lines: ["Query: releases"],
    },
  )
})

test("shows generic MCP permission resources", () => {
  expect(
    permissionPresentation({ action: "shield_oam_command", resources: ["sysinfo.cpu.extended_show"] }),
  ).toMatchObject({
    title: "Call tool shield_oam_command",
    lines: ["Tool: shield_oam_command", "- sysinfo.cpu.extended_show"],
  })
  expect(
    permissionPresentation({
      action: "shield_oam_command",
      resources: ["*", "sysinfo.cpu.get", "sysinfo.hostname.get"],
    }).lines,
  ).toEqual(["Tool: shield_oam_command", "- sysinfo.cpu.get", "- sysinfo.hostname.get"])
})

test("preserves generic permission display for wildcard or empty resources", () => {
  expect(permissionPresentation({ action: "shield_oam_command", resources: ["*"] }).lines).toEqual([
    "Tool: shield_oam_command",
  ])
  expect(permissionPresentation({ action: "shield_oam_command", resources: [] }).lines).toEqual([
    "Tool: shield_oam_command",
  ])
})
