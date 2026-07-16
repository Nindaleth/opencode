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

Updated the internal API.

When selecting a non-default reasoning effort variant of a model, a "user Bash" tool call no longer resets the variant.

No configuration necessary.

Works across TUI, Desktop app, Web UI and CLI.

# feature/fox-03-modify-system-prompt

Expanded plugin API, introduced a built-in plugin `prompt-overrides`.

Model families and built-in tools can now have their prompts overrriden, using either direct strings or file pointers, via opencode.json.

A new debug subcommand `opencode debug prompt` is implemented to dump the system part of the initial user prompt, with provider/model and agent optionally configurable. If not provided, TUI startup defaults apply.

Example call: `opencode debug prompt --provider github-copilot --model gpt-5.6-terra --agent build`

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

Every assistant message (in both main and subagent sessions) now displays the number of output tokens generated and throughput per second in its footer.

No configuration necessary.

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

The Web UI served by `opencode web` now allows completely hiding tool call message parts in the session.

Use Settings -> General -> Show tool calls to toggle.

Desktop app and Web UI only.

# feature/fox-10-web-downloadable-files

The Web UI now allows downloading files that were sent by MCP servers. OpenCode saves these binary parts on disk to `~/.local/share/opencode/blob/`, then puts a short notice into LLM context.

A new session message type is introduced to display the downloadable file even when "Show tool calls" is disabled.

Web UI only.

# feature/fox-11-reload-command

A new command `/reload` is available that allows reloading the newest available state of all commands, skills, AGENTS.md and opencode.json(c) configuration file.

Only the current directory's worker instance is refreshed, any other ones are kept unchanged.

Server plugin changes listed in opencode.json(c) (downloaded from NPM) are handled, TUI plugins are not. The tui.json(c) config is not reloaded.

Known gap: the busy-session check and instance replacement are separate operations. A session that becomes busy after the check but before replacement can therefore be interrupted by `/reload`. Fixing this correctly requires directory-scoped lifecycle leases and an exclusive conditional reload operation in `packages/opencode/src/project/instance-store.ts`; repeating the status check would not make the operation atomic. The fix also needs to route instance HTTP requests through the lease in `packages/opencode/src/server/routes/instance/httpapi/middleware/instance-context.ts`, use the conditional operation in `packages/opencode/src/cli/tui/reload.ts` and add deterministic race coverage in `packages/opencode/test/project/instance.test.ts` and `packages/opencode/test/cli/tui/reload.test.ts`. This issue is currently ignored because it's low-risk and low-damage in a local TUI usage scenario.

TUI only.

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
