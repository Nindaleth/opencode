import { expect, test } from "bun:test"
import { join } from "node:path"

// Packaged windows load the renderer through the privileged `oc://` protocol, where a root-relative
// path such as `src="/foo.js"` resolves from the protocol origin instead of next to the HTML entry.
test("index.html references local resources by relative path and has no web manifest", async () => {
  const content = await Bun.file(join(import.meta.dirname, "index.html")).text()

  const paths = [...content.matchAll(/\bsrc=["']([^"']+)["']|<link[^>]+href=["']([^"']+)["']/g)].map(
    (match) => match[1] ?? match[2],
  )

  expect(paths.length).toBeGreaterThan(0)

  for (const path of paths) expect(path).not.toMatch(/^\/[^/]/)
  // A web app manifest does not apply in Electron.
  expect(content).not.toContain('rel="manifest"')
})

// Nothing awaits before render, so startup work cannot delay first paint.
test("the renderer entry renders before awaiting anything", async () => {
  const entry = await Bun.file(join(import.meta.dirname, "index.tsx")).text()
  const render = entry.indexOf("render(")
  expect(render).toBeGreaterThan(-1)
  expect(entry.slice(0, render)).not.toMatch(/\bawait\b/)
})

// Release builds bake in a Sentry DSN, so any SDK import would report errors to Sentry.
test("neither the desktop renderer nor the app it bundles loads Sentry", async () => {
  for (const dir of [import.meta.dirname, join(import.meta.dirname, "../../../app/src")]) {
    for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: dir })) {
      if (file.includes(".test.")) continue
      expect(`${file}: ${await Bun.file(join(dir, file)).text()}`).not.toMatch(/["']@sentry\//)
    }
  }
})
