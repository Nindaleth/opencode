# Fox features in OCD V2

All these branches form a cumulative chain on top of upstream `dev` (V2 branch), each building on the previous one. The current base is release `v2.2.7` (`fedc6f208a`).

The stack is checked with package typechecks and its changed regression tests, including browser and component tests where applicable. These checks complement usage testing.

| V2 branch                                         | Change                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `feature/v2-fox-01-subagent-model`                | Routes subagents to configured models.                                             |
| `feature/v2-fox-02-bash-preserve-reasoning`       | Already in V2; regression tests only.                                              |
| `feature/v2-fox-03-modify-system-prompt`          | Adds prompt overrides and `debug prompt`.                                          |
| `feature/v2-fox-04-display-model-variant`         | Shows the reasoning variant in session views.                                      |
| `feature/v2-fox-05-display-subagent-costs`        | Includes subagent costs in the session cost.                                       |
| `feature/v2-fox-06-token-count-speed`             | **Empty commit:** V2 already shows token throughput.                               |
| `feature/v2-fox-07-bash-exit-code`                | **Partly upstream:** adds successful shell exit status and TUI output.             |
| `feature/v2-fox-08-sort-skills-list`              | Sorts the TUI skills dialog.                                                       |
| `feature/v2-fox-09-web-toggle-toolcalls`          | **Empty commit:** V2 already can hide tool calls.                                  |
| `feature/v2-fox-10-web-downloadable-files`        | Adds named MCP binary downloads beyond upstream artifacts.                         |
| `feature/v2-fox-11-reload-command`                | **Empty commit:** V2 already has Web UI `/reload`.                                 |
| `feature/v2-fox-12-session-cost-limit`            | Adds per-prompt session cost limits.                                               |
| `feature/v2-fox-13-enlarge-horizontal-tabs`       | Makes horizontal TUI session tabs taller and wider.                                |
| `feature/v2-fox-14-last-tabclose-exits`           | Closing the last TUI tab exits.                                                    |
| `feature/v2-fox-15-passwordless-web-access`       | Opt-in passwordless web and API access.                                            |
| `feature/v2-fox-16-clipboard-dumb-terminals`      | `wl-copy` clipboard fallback on Wayland.                                           |
| `feature/v2-fox-17-unchecked-mcp-tls`             | Per-server MCP TLS verification bypass.                                            |
| `feature/v2-fox-18-display-subagent-tokens`       | Shows subagent context usage.                                                      |
| `feature/v2-fox-19-mcp-command-permissions`       | **Partly upstream:** adds argument-scoped MCP permissions; V2 displays tool input. |
| `feature/v2-fox-20-next-steps`                    | Adds session-aware next-message suggestions.                                       |
| `feature/v2-fox-21-no-always-allow`               | Adds ask-rule control over Always allow.                                           |
| `feature/v2-fox-22-notify-http`                   | Posts session notifications to an HTTP endpoint.                                   |
| `feature/v2-fox-23-web-permission-base64-preview` | **Partly upstream:** adds decoded base64 previews and selectable permission text.  |
| `feature/v2-fox-24-prevent-data-exfiltration`     | Stops link hosts, crashes and prompts leaking out.                                 |
| `feature/v2-fox-25-proper-cost-tracking`          | **Partly upstream:** adds Copilot cache-write pricing; V2 tracks generation costs. |

"Empty commit" means the branch's own commit has no file changes.

The top branch, `feature/v2-fox`, combines the stack with the repository's V2 GitHub tools plugin, fix for iframe-wrapped Web UI in Firefox and this guide.

# feature/v2-fox-01-subagent-model

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
            "parentModel": "github-copilot/claude-fable-*",
            "model": "github-copilot/claude-opus-5.5",
            "variant": "medium"
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

# feature/v2-fox-02-bash-preserve-reasoning

Already present in upstream V2; the V2 branch adds regression tests only.

A "user Bash" tool call no longer resets a non-default reasoning effort variant.

No configuration necessary.

Works across TUI, Desktop app, Web UI and CLI.

# feature/v2-fox-03-modify-system-prompt

Expanded plugin API, introduced a built-in plugin `prompt-overrides`.

Model families and built-in tools can have their prompts overridden via opencode.json, using either direct strings or file pointers.

`opencode debug prompt` dumps the system part of the initial user prompt. Provider/model and agent are optional and default to the TUI startup values, for example: `opencode debug prompt --provider github-copilot --model gpt-5.6-terra --agent build`

**DCP workaround:** `@tarquinen/opencode-dcp` (tested with 3.2.0) fails on the unsaved Session that `debug prompt` builds, so `debug prompt` skips DCP's `session.context` hook and its output omits DCP's instructions and tool filtering.

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
            "file": "/home/{env:USER}/prompts/sonnet-system.txt"
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
              "file": "/home/{env:USER}/prompts/apply-patch.txt"
            }
          ]
        }
      }
    ]
  ]
```

Works across TUI, Desktop app, Web UI and CLI.

# feature/v2-fox-04-display-model-variant

A reasoning effort variant (low/medium/high/...) is now shown in both main and subagent sessions after every assistant message, and in their footers (originally just in the main session footer).

No configuration necessary.

TUI only.

# feature/v2-fox-05-display-subagent-costs

The prompt footer and context sidebar include the cost of all nested subagent tasks, for example `$1.42 ($0.37 + $1.05 by 3 tasks)`.

No configuration necessary.

TUI only.

# feature/v2-fox-06-token-count-speed

Upstream V2 already shows turn-wide tokens per second (output and reasoning across steps), controlled by the session `tps` setting (enabled by default).

TUI only.

# feature/v2-fox-07-bash-exit-code

Successful shell tool output includes `Command exited with code 0.`, including commands that produce no stdout or stderr.

Upstream already reports nonzero exits, signals and timeouts and handles saved shell output through its run state machine. This branch keeps those notices and adds successful exit status and TUI display of completed foreground output.

No configuration necessary.

Works across TUI, Desktop app, Web UI.

# feature/v2-fox-08-sort-skills-list

The `/skills` command now shows the skills listed alphabetically, case-insensitive.

No configuration necessary.

TUI only.

# feature/v2-fox-09-web-toggle-toolcalls

Upstream V2 already has this: pick **Text only** under Settings -> General -> Timeline detail, or hide individual activity categories. Failed tool calls can stay visible.

Desktop app and Web UI only.

# feature/v2-fox-10-web-downloadable-files

The Web UI can download files sent by MCP servers. OpenCode saves them to `~/.local/share/opencode/blob/` and puts a short notice into LLM context. The download stays visible even when timeline detail settings hide tool activity.

Upstream's experimental artifacts publish UTF-8 string files with project/provider ownership; they do not preserve arbitrary MCP binary bytes or provide message-owned named downloads. This branch keeps session-scoped artifact storage and download UI alongside upstream's artifacts and media blobs. The old GUI extension metrics module was removed upstream, so this branch no longer changes it.

The file preview's `... -> Download` action also supports binary files, including Office documents and PDFs, preserving their original bytes. Upstream only offers this action for text files. This preview download enhancement works in both the Desktop app and Web UI.

Works across Web UI (MCP download cards, File preview downloads) and Desktop app (File preview downloads).

# feature/v2-fox-11-reload-command

Upstream V2 already has `/reload` in the TUI, CLI, HTTP API and Web UI composers and command palette, including pending, success and error feedback. The V2 branch is now an empty parity commit.

Reload applies edits to configuration, `AGENTS.md`, skills and commands without restarting the server. Running sessions pick them up at the next step boundary.

Works Web UI, TUI and CLI.

# feature/v2-fox-12-session-cost-limit

Expanded the plugin API and introduced the built-in `cost-limit` plugin.

The V2 plugin documentation is in `services/site/src/docs/content/plugins.mdx`.

The plugin limits the cost of one user prompt, with separate dollar budgets for the parent session and all its subagents. Next user prompt resets the limits.

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

Rules match the root model (`providerID/modelID`, `*` wildcards). The last matching rule replaces `default` entirely, so an omitted value means no limit.

A session that hits its limit finishes the current turn and stops. A stopped subagent returns its partial result to the parent.

Works across TUI, Desktop app, Web UI and CLI.

# feature/v2-fox-13-enlarge-horizontal-tabs

Horizontal TUI session tabs are now three rows tall and wider (preferred 35 columns, maximum 50).

No configuration necessary.

TUI only.

# feature/v2-fox-14-last-tabclose-exits

Closing the last tab (Ctrl+D or the "x" button) exits the TUI, so repeated Ctrl+D closes all sessions and then quits.

No configuration necessary.

TUI only.

# feature/v2-fox-15-passwordless-web-access

Opt-in passwordless mode disables authentication for the whole HTTP server (Web UI and API), so anyone who can reach it can read sessions and run tools. Use it only on a trusted network.

For a foreground server, pass `--passwordless` (can't be combined with `--service` or `--stdio`):

```sh
opencode serve --hostname 0.0.0.0 --port 4096 --passwordless
```

For the managed background service:

```sh
opencode service set hostname 0.0.0.0
opencode service set passwordless true
opencode service start
```

To restore password protection, run `opencode service set passwordless false` and start the service again.

Web UI only, applies to all HTTP clients connecting to the server.

# feature/v2-fox-16-clipboard-dumb-terminals

On Wayland, when the native clipboard is unsupported (for example in a container terminal without OSC 52), the TUI copies via `wl-copy`. Requires `WAYLAND_DISPLAY` and `wl-copy` on `PATH`; in a container, the Wayland socket must be reachable from inside.

No configuration necessary.

TUI only.

# feature/v2-fox-17-unchecked-mcp-tls

To skip TLS certificate verification for one remote MCP server, for example with a self-signed certificate, set `skip_tls_verify: true` for it:

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

This disables all certificate checks for that server, not just self-signed rejection. Other connections and the OAuth login flow are unaffected. Requires the Bun runtime (default in all OpenCode releases).

Works across TUI, Desktop app, Web UI and CLI.

# feature/v2-fox-18-display-subagent-tokens

Subagent tool rows in the parent transcript and the Subagents picker show the subagent's latest context usage, for example `20.0K (20%)`. This is context utilisation, same as the main session's display. It updates after each model step.

No configuration necessary.

TUI only.

# feature/v2-fox-19-mcp-command-permissions

`permission_resources` on an MCP server maps a tool name to one of its top-level string arguments, so permission rules match that argument instead of `*`. Unmapped tools keep whole-tool permissions.

Partly upstream: V2 already shows the tool name and full input as labeled fields in permission prompts. This branch reuses that display instead of adding a second JSON preview; argument-scoped permission matching remains its extension. The branch updates the canonical protocol OpenAPI spec and generated client, without restoring the website's upstream-deleted spec copies.

For a server `operations` with a tool `run`, this checks permissions against param `parameter_name`, then allows read-only commands and asks for everything else:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "operations": {
        "type": "remote",
        "url": "https://mcp.example.com/mcp",
        "permission_resources": {
          "run": "parameter_name",
        },
      },
    },
  },
  "permissions": [
    { "action": "operations_run", "resource": "*", "effect": "ask" },
    { "action": "operations_run", "resource": "*.*.get", "effect": "allow" },
    { "action": "operations_run", "resource": "*.*.show", "effect": "allow" },
  ],
}
```

The last matching rule wins and `*` spans dots, so `sysinfo.hostname.get` is allowed while `sysinfo.cpu.extended_show` asks. Always allow saves the argument value as the pattern instead of approving the whole tool.

Works across TUI, Desktop app, Web UI and CLI.

# feature/v2-fox-20-next-steps

After the latest reply finishes successfully, the Web UI shows up to three suggested next messages below it. Clicking one puts it into the composer for editing; nothing is sent until you submit it.

Suggestions stay hidden under older replies and while the session is busy.

Each reply costs an extra model call. Turn it off with "Suggest next steps" in Settings - General. By default it uses the session model at its lowest reasoning variant. A hidden `next-steps` agent lets you pick another model or replace the prompt:

```jsonc
{
  "agents": {
    "next-steps": {
      "model": "provider/model",
      "system": "Suggest concise, useful next messages. Prefer concrete verification steps.",
    },
  },
}
```

On GitHub Copilot the requests count as agent-initiated, like title generation.

Upstream's stateless decision-generation API does not provide these session-aware suggestions. This branch keeps its Session endpoint and the canonical protocol spec, without restoring the website's removed OpenAPI copies.

Web UI and Desktop app only.

# feature/v2-fox-21-no-always-allow

An ask rule with `offer_always: false` removes Always allow from its prompts and ignores earlier saved approvals. Use it for actions that need a fresh decision every time, such as commands that change production env:

```jsonc
{
  "permissions": [
    { "action": "operations_run", "resource": "*", "effect": "ask", "offer_always": false },
    { "action": "operations_run", "resource": "*.*.add", "effect": "ask", "offer_always": true },
    { "action": "operations_run", "resource": "*.*.get", "effect": "allow" },
    { "action": "operations_run", "resource": "*.*.show", "effect": "allow" },
  ],
}
```

Here `monitor.processes.restart` offers only Allow once and Reject, while `sender.blacklist.add` also offers Allow always.

The rule schema and generated client extend upstream's permission model; the website's removed OpenAPI copies stay deleted.

Works across TUI, Desktop app, Web UI and ACP clients.

# feature/v2-fox-22-notify-http

Introduced a built-in plugin `notify-http`. It posts desktop notifications to a [notify-send-http](https://github.com/fgrehm/notify-send-http) server, so OpenCode running in a container can trigger notifications on the host.

opencode.json `notify-http` plugin configuration example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "notify-http",
      "options": {
        "url": "http://host.docker.internal:12345",
        "enabled": true,
      },
    },
  ],
}
```

`url` is required unless `enabled` is `false`. On Linux, start the container with `--add-host=host.docker.internal:host-gateway` or use the host IP.

Each notification is a form POST with `summary` set to `OpenCode: <session directory>` (home shortened to `~`) and `body` set to one of:

- `Session done: <title>` when a run finishes or is interrupted, unless a client marks the session as viewed within 2 seconds
- `Session failed: <title>` followed by the error message
- `Input needs response: <title>` followed by the question title
- `Permission needs input: <title>` followed by the action and its message

Subagent sessions don't notify, and each question or permission request notifies once. Failed requests time out after 5 seconds and are only logged.

To start the notify-send-http server with the desktop session and restart it after a crash, put the server binary at `~/.local/bin/notify-send-http` and add a systemd user unit `~/.config/systemd/user/notify-send-http.service`:

```ini
[Unit]
Description=notify-send-http server
PartOf=graphical-session.target
After=graphical-session.target

[Service]
Environment=PORT=12345
ExecStart=%h/.local/bin/notify-send-http
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes

[Install]
WantedBy=graphical-session.target
```

Enable it with `systemctl --user daemon-reload && systemctl --user enable --now notify-send-http.service` and follow its log with `journalctl --user -u notify-send-http -f`. The server listens on all interfaces without authentication, so restrict port 12345 to the container network with a firewall.

Works across TUI, Desktop app, Web UI and CLI.

# feature/v2-fox-23-web-permission-base64-preview

Partly upstream: V2 already shows labeled raw tool input in permission prompts. This branch reuses that layout and adds decoded base64 previews and selectable permission text rather than duplicating the raw input display.

When a permission request has a parameter whose name contains `base64`, the prompt shows its decoded value alongside the raw input, labeled `<name> (decoded)`, with a vertical line on the left of the decoded text. The whole decoded value is shown; long values scroll in their own box, like the raw input does. Values that don't decode to UTF-8 text get no preview.

The prompt's description, patterns, previews and raw input can now be selected and copied.

No configuration necessary.

Web UI and Desktop app only.

# feature/v2-fox-24-prevent-data-exfiltration

Stops three ways data left the machine without being asked for:

- Link favicons in messages were loaded from Google's favicon service, which saw the hostname of every external link, internal hosts included. They are now off by default; turn them on with Settings > General > Show link favicons. github.com links keep their local icon either way. Toggling the setting affects only messages rendered afterwards.
- Sentry error reporting is removed. Official desktop and web builds had a Sentry DSN baked in at build time and reported crashes with no way to turn it off.
- A free OpenCode model (`opencode` or `opencode-go` with no input cost) is never picked as the default. Without a model from `--model`, config or recent use, the server, TUI and Desktop/Web app pick the first non-free model of an enabled provider instead (the server picks the newest released). With only free models available, you have to pick one. Free models picked explicitly, in config or from recent use still work.

Works across TUI, Desktop app, Web UI and CLI.

# feature/v2-fox-25-proper-cost-tracking

GitHub Copilot's advertised cache-write prices are included in calculated model costs instead of being treated as zero.

Upstream V2 already records cost and tokens for successful session generation calls, including `ctx.session.generate`, without adding their prompts or responses to conversation history. It uses provider-reported cost when available, otherwise catalog prices.

No configuration necessary.

Works across TUI, Desktop app, Web UI and CLI.
