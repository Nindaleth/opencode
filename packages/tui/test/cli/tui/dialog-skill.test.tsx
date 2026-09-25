/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { DialogSkill } from "../../../src/component/dialog-skill"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { emptyThemeSource } from "../../fixture/fixture"
import { createApi, createFetch, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("skills were displayed in discovery order instead of case-insensitive alphabetical order", async () => {
  const location = {
    directory: process.cwd(),
    project: { id: "proj_test", directory: process.cwd(), canonical: process.cwd() },
  }
  const client = createFetch((url) => {
    if (url.pathname !== "/api/skill") return undefined
    return json({
      location,
      data: [
        { id: "zebra", name: "zebra", description: "Last" },
        { id: "apple", name: "apple", description: "Second" },
        { id: "alpha", name: "Alpha", description: "First" },
      ],
    })
  })

  function Probe() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <DialogSkill onSelect={() => {}} />))
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ToastProvider>
              <ClientProvider api={createApi(client.fetch)}>
                <DataProvider directory={process.cwd()}>
                  <ThemeProvider mode="dark" source={emptyThemeSource}>
                    <DialogProvider>
                      <Probe />
                    </DialogProvider>
                  </ThemeProvider>
                </DataProvider>
              </ClientProvider>
            </ToastProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )

  try {
    app.renderer.start()
    const frame = await app.waitForFrame((value) => value.includes("zebra") && value.includes("Alpha"))
    expect(frame.indexOf("Alpha")).toBeLessThan(frame.indexOf("apple"))
    expect(frame.indexOf("apple")).toBeLessThan(frame.indexOf("zebra"))
  } finally {
    app.renderer.destroy()
  }
})
