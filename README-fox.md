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
