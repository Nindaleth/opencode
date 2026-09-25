# Fox features in V2

The `feature/v2-fox-01-*` through `feature/v2-fox-17-*` branches form a cumulative chain on top of upstream `v2`. Each numbered branch builds on the previous branch. The sections below describe the original `feature/fox-*` features and V2-only additions; the table records what each V2 branch actually contributes.

| V2 branch                                    | Status relative to upstream `v2`                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `feature/v2-fox-01-subagent-model`           | Ports subagent model routing.                                                                                   |
| `feature/v2-fox-02-bash-preserve-reasoning`  | Behaviour already present in V2; adds regression tests only.                                                    |
| `feature/v2-fox-03-modify-system-prompt`     | Ports prompt overrides and debug prompt preview, with a DCP-specific preview workaround.                        |
| `feature/v2-fox-04-display-model-variant`    | Adds reasoning variant display in V2 session views.                                                             |
| `feature/v2-fox-05-display-subagent-costs`   | Adds aggregate subagent costs to the V2 TUI.                                                                    |
| `feature/v2-fox-06-token-count-speed`        | **Empty commit:** V2 already shows turn-wide token throughput; see the difference below.                        |
| `feature/v2-fox-07-bash-exit-code`           | Adds shell exit codes to V2 session output.                                                                     |
| `feature/v2-fox-08-sort-skills-list`         | Sorts the V2 TUI skills dialog.                                                                                 |
| `feature/v2-fox-09-web-toggle-toolcalls`     | **Empty commit:** V2 already has timeline visibility settings; see the difference below.                        |
| `feature/v2-fox-10-web-downloadable-files`   | Ports downloadable MCP binary artifacts to V2.                                                                  |
| `feature/v2-fox-11-reload-command`           | Adds `/reload` to the Web UI using the existing configuration reload endpoint.                                  |
| `feature/v2-fox-12-session-cost-limit`       | Ports per-prompt session cost limits to V2.                                                                     |
| `feature/v2-fox-13-enlarge-horizontal-tabs`  | Makes horizontal TUI session tabs taller and wider.                                                             |
| `feature/v2-fox-14-last-tabclose-exits`      | Repeated "tab close" actions close TUI with the last tab, no need for a specific quit shortcut.                 |
| `feature/v2-fox-15-passwordless-web-access`  | Adds opt-in passwordless access for foreground and managed web/API servers.                                     |
| `feature/v2-fox-16-clipboard-dumb-terminals` | Copies TUI selections through `wl-copy` when the native clipboard backend is unsupported on Wayland.            |
| `feature/v2-fox-17-unchecked-mcp-tls`        | Adds opt-in TLS certificate-verification bypass for one remote MCP server without changing global TLS settings. |

"Empty commit" means the branch's own commit has no file changes, not that the cumulative branch has no changes. Branch 02 changes tests but no production code. The two empty commits are 06 and 09.

# feature/fox-01-subagent-model

Expanded plugin API, introduced a built-in plugin `subagent-router`.

For `task` tool, the subagent model and reasoning effort variant can be overriden by the plugin rules configuration.

The matching is by subagent name and parent model.

opencode.json `subagent-router` plugin configuration example:

```
  "plugin": [
    [
      "subagent-router",
      {
        "rules": [
          {
            "subagent": "explore",
            "parentModel": "anthropic/*",
            "model": "openai/gpt-5-mini",
            "variant": "high"
          },
          {
            "subagent": "general",
            "parentModel": ["github-copilot/*", "openai/gpt-5*"],
            "model": "anthropic/claude-sonnet-4-6"
          }
        ]
      }
    ]
  ]
```

Works across TUI, Desktop app, Web UI and CLI.

# feature/fox-02-bash-preserve-reasoning

Already present in upstream V2. The V2 branch adds regression tests, not an API or behavior change.

When selecting a non-default reasoning effort variant of a model, a "user Bash" tool call no longer resets the variant.

No configuration necessary.

Works across TUI, Desktop app, Web UI and CLI.

# feature/fox-03-modify-system-prompt

Expanded plugin API, introduced a built-in plugin `prompt-overrides`.

Model families and built-in tools can now have their prompts overrriden, using either direct strings or file pointers, via opencode.json.

A new debug subcommand `opencode debug prompt` is implemented to dump the system part of the initial user prompt, with provider/model and agent optionally configurable. If not provided, TUI startup defaults apply.

Example call: `opencode debug prompt --provider github-copilot --model gpt-5.6-terra --agent build`

**DCP-specific preview workaround:** The third-party `@tarquinen/opencode-dcp` plugin (tested with version 3.2.0) loads the stored Session in its `session.context` hook. This fork's debug preview uses an unsaved Session and marks hook events with `preview: true`; DCP ignores that flag, so its lookup fails and the command returns HTTP 500. Upstream V2 does not have this unsaved preview path, so DCP's stored-Session assumption works there.

In `packages/core/src/plugin.ts`, the plugin context wrapper skips only `session.context` callbacks registered by plugin ID `opencode-dcp` when `preview` is true. Normal sessions, other DCP hooks, other plugins and tool-description overrides remain active; unrelated hook errors still propagate.

The preview keeps DCP's registered `compress` tool but omits the instructions and per-session tool filtering that DCP's context hook would apply. It is therefore not an exact preview of DCP's live prompt. A preview-aware DCP hook that renders instructions without loading or mutating persisted Session state would remove the need for this workaround.

opencode.json `prompt-overrides` plugin configuration example:

```
  "plugin": [
    [
      "prompt-overrides",
      {
        "model": [
          {
            "match": "openai/gpt-5*",
            "text": "Replacement base system prompt"
          },
          {
            "match": "anthropic/claude-sonnet-4-6",
            "file": "./prompts/sonnet-system.txt"
          }
        ],
        "tool": {
          "bash": [
            {
              "match": "*",
              "text": "Replacement tool description for bash"
            }
          ],
          "apply_patch": [
            {
              "match": "openai/gpt-5*",
              "file": "./prompts/apply-patch.txt"
            }
          ]
        }
      }
    ]
  ]
```

Works across TUI, Desktop app, Web UI and CLI.

# feature/fox-04-display-model-variant

A reasoning effort variant (low/medium/high/...) is now shown in both main and subagent sessions after every assistant message, and in their footers (originally just in the main session footer).

No configuration necessary.

TUI only.

# feature/fox-05-display-subagent-costs

Parent session cost displays now include the cost of all nested subagent tasks if those available.

When delegated tasks exist, the prompt footer and context sidebar display the total, parent-session cost, delegated cost, and task count, for example `$1.42 ($0.37 + $1.05 by 3 tasks)`. Sessions without subagent tasks retain their local cost display.

No configuration necessary.

TUI only.

# feature/fox-06-token-count-speed

The original fox feature displays per-assistant-message output token counts and output-only tokens per second. Upstream V2 already displays turn-wide tokens per second in the TUI (including output and reasoning across assistant steps). This is a different metric; the V2 branch's commit is empty rather than adding a second rate or the per-message output count.

V2's throughput display is controlled by the session `tps` setting (enabled by default).

TUI only.

# feature/fox-07-bash-exit-code

Shell tool output now includes `Command exited with code N.` for every completed command, including commands that produce no stdout or stderr.

No configuration necessary.

Works across TUI, Desktop app, Web UI.

# feature/fox-08-sort-skills-list

The `/skills` command now shows the skills listed alphabetically, case-insensitive.

No configuration necessary.

TUI only.

# feature/fox-09-web-toggle-toolcalls

Upstream V2 already offers timeline detail settings in the Desktop app and Web UI. Select the **Text only** preset under Settings -> General -> Timeline detail, or configure individual activity categories, to hide tool activity. Failed tool calls can remain visible even when a category is hidden, unlike the original fox feature's blanket toggle. The V2 branch's commit is empty.

Desktop app and Web UI only.

# feature/fox-10-web-downloadable-files

The Web UI now allows downloading files that were sent by MCP servers. OpenCode saves these binary parts on disk to `~/.local/share/opencode/blob/`, then puts a short notice into LLM context.

A new session message type displays the downloadable file even when tool activity is hidden by V2's timeline detail settings.

Web UI only.

# feature/fox-11-reload-command

Upstream V2 already has `/reload` in the TUI, a `location.reload` keybinding, a CLI reload command and an HTTP reload endpoint. The V2 branch adds `/reload` to the Web UI's new-session and existing-session composers and command palette. It calls the same endpoint and shows a success or error notification.

Reload rebuilds loaded locations so edits to configuration, `AGENTS.md`, skills and commands take effect without restarting the server. Running sessions can resume with fresh services at a step boundary. The original fox implementation's directory-scoped, busy-session-blocking reload and its associated race note do not describe V2's reload behaviour.

Web UI and TUI; the CLI also supports configuration reload.

# feature/fox-12-session-cost-limit

Expanded the plugin API and introduced the built-in `cost-limit` plugin.

The plugin limits the cost of one user prompt with separate dollar budgets for the root session and all its subagents. Reaching either budget stops processing at the next turn boundary. Send a new root-session message to start a fresh allowance.

opencode.json `cost-limit` plugin configuration example:

```
  "plugin": [
    [
      "cost-limit",
      {
        "default": {
          "parent": 5.0,
          "subagents": 10.0
        },
        "rules": [
          {
            "model": "github-copilot/claude-opus-*",
            "parent": 8.0,
            "subagents": 15.0
          },
          {
            "model": "github-copilot/gpt-5.6-luna",
            "parent": 1.5,
            "subagents": 4.0
          }
        ]
      }
    ]
  ]
```

`parent` limits the root session's own spend. `subagents` limits the combined spend of every delegated subagent. Both limits are in dollars per root user prompt.

Rules match the root model as `providerID/modelID` and support `*` wildcards. The last matching rule replaces `default` rather than merging with it, so omit either value to disable that budget for the matching rule. Without `default`, no limit applies unless a rule matches.

The first turn of a prompt always runs. A session that reaches a limit completes its current turn before stopping. If a subagent stops, its partial result and the stop reason return to the parent session.

Works across TUI, Desktop app, Web UI and CLI.

# feature/fox-13-enlarge-horizontal-tabs

Horizontal session tabs in the TUI are now three rows tall, with their contents centred vertically. Their preferred width increases from 22 to 35 terminal columns, and their maximum width from 32 to 50. Tabs still shrink or overflow when space is limited.

No configuration necessary.

TUI only.

# feature/fox-14-last-tabclose-exits

Closing the last session tab or an empty new-session tab now exits the TUI. This applies to the `session.tab.close` command and the "x" tab button. Closing a tab while another remains keeps the TUI open; internal cleanup such as `/clear` or failed session recovery does not exit. Similarly to how Ctrl+C is multi-purpose (it first clears the prompt box and only then exits), Ctrl+D now closes all available sessions and with the last one the TUI too.

No configuration necessary.

TUI only.

# feature/v2-fox-15-passwordless-web-access

Passwordless web access is now opt-in. It disables authentication for the entire HTTP server, including the Web UI and API, so anyone who can reach the server can read sessions and invoke its tools. Use it only behind a trusted company network or other effective network access control. CORS settings do not restrict who can call the API.

For a foreground server, pass the new `--passwordless` flag:

```sh
opencode serve --hostname 0.0.0.0 --port 4096 --passwordless
```

Without the flag, `opencode serve` still requires its generated or configured password. The flag applies only to foreground `serve`; it cannot be combined with `--service` or `--stdio`.

For the managed background service, set the new persistent boolean `passwordless` setting and restart the service:

```sh
opencode service set hostname 0.0.0.0
opencode service set passwordless true
opencode service start
```

`opencode service set passwordless true` stops a running service before saving the setting. `opencode service get passwordless` prints `true` or `false`. To restore password protection, run `opencode service set passwordless false` followed by `opencode service start`; `opencode service unset passwordless` also restores the default (`false`). Only the literal values `true` and `false` are accepted. The managed service still keeps its private discovery password for local clients, but passwordless mode does not enforce it on HTTP requests.

Web UI only, applies to all HTTP clients connecting to the server.

# feature/v2-fox-16-clipboard-dumb-terminals

When the native clipboard backend reports `unsupported` on Wayland, the V2 TUI uses `wl-copy` to write text to the system clipboard. This lets plain mouse-drag selection copy to the host clipboard even when a container's terminal does not support OSC 52. Native clipboard writes retain priority, and the TUI also tries the host clipboard when OpenTUI classifies the terminal as remote.

The fallback requires `WAYLAND_DISPLAY` and `wl-copy` on the TUI process's `PATH`. In a container, the Wayland socket must also be accessible from inside the container. No OpenCode configuration is needed. The fallback uses the shared TUI clipboard path, so it also applies to other TUI text-copy actions.

Shift-drag uses the terminal's own selection rather than the TUI's copy path. Terminal redraws during generation can still erase that selection; this feature does not change Shift-drag behavior.

No configuration necessary.

TUI only.

# feature/v2-fox-17-unchecked-mcp-tls

OpenCode always verifies the TLS certificate of a remote MCP server exposed via HTTPS.

This requires a Bun backend (which is the default for all OpenCode release types). It does not apply to custom OpenCode hosts built with @opencode/sdk running on Node.js or other non-Bun runtimes.

The separate OAuth login flow is unchanged.

To skip this for a server with a self-signed certificate, set `skip_tls_verify: true` for that server:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "my-server": {
        "type": "remote",
        "url": "https://localhost:8443/mcp",
        "oauth": false,
        "skip_tls_verify": true,
      },
    },
  },
}
```

Omitting the field or setting it to `false` keeps certificate verification enabled. Other MCP connections and model-provider requests are unaffected; no global TLS setting is changed.

This option applies to that server's HTTP transport; it disables all certificate checks, not just self-signed certificate rejection. Encryption remains enabled, but the peer's identity is not verified.

Works across TUI, Desktop app, Web UI and CLI.
