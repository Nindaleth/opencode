import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OPENCODE_VERSION } from "../src/version"

test("debug prompt sends explicit selection and prints the server's preview", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-debug-prompt-"))
  const preview = {
    selection: { provider: "custom", model: "chat", agent: "build" },
    system: ["custom system"],
    tools: [{ name: "read", description: "custom read" }],
  }
  let requested: URL | undefined
  let healthProbes = 0
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requested = new URL(request.url)
      if (requested.pathname === "/api/info") {
        healthProbes++
        return Response.json({ version: OPENCODE_VERSION, pid: process.pid, urls: [], paths: { tmp: directory } })
      }
      return Response.json(preview)
    },
  })
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        path.join(import.meta.dir, "../src/index.ts"),
        "debug",
        "prompt",
        "--server",
        server.url.toString(),
        "--provider",
        "custom",
        "--model",
        "chat",
        "--agent",
        "build",
      ],
      { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(JSON.parse(stdout)).toEqual(preview)
    expect(requested?.pathname).toBe("/api/debug/prompt")
    expect(requested?.searchParams.get("location[directory]")).toBe(path.join(import.meta.dir, ".."))
    expect(requested?.searchParams.get("provider")).toBe("custom")
    expect(requested?.searchParams.get("model")).toBe("chat")
    expect(requested?.searchParams.get("agent")).toBe("build")
    expect(healthProbes).toBe(1)
  } finally {
    server.stop(true)
    await fs.rm(directory, { recursive: true, force: true })
  }
})
