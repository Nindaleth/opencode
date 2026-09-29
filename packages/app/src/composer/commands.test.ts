import { expect, test } from "bun:test"
import { createReloadCommand } from "./commands"

test("Reload configuration was missing from the Web slash commands", async () => {
  const notices: { variant: string; title: string; description?: string }[] = []
  const requests: string[] = []
  const option = createReloadCommand({
    reload: async () => {
      requests.push("reload")
    },
    t: (key) => key,
    notify: (notice) => notices.push(notice),
  })

  expect(option.slash).toBe("reload")
  expect(option.title).toBe("command.location.reload")
  await option.onSelect?.("slash")
  expect(requests).toEqual(["reload"])
  expect(notices).toEqual([{ variant: "success", title: "toast.location.reload.success.title" }])
})

test("A failed configuration reload was reported as successful", async () => {
  const notices: { variant: string; title: string; description?: string }[] = []
  const option = createReloadCommand({
    reload: async () => {
      throw new Error("Location unavailable")
    },
    t: (key) => key,
    notify: (notice) => notices.push(notice),
  })

  await option.onSelect?.("slash")
  expect(notices).toEqual([
    { variant: "error", title: "toast.location.reload.failed.title", description: "Location unavailable" },
  ])
})
