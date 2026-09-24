import { Effect, Plugin, Schema } from "@opencode/plugin"

const TEAM = {
  tui: ["kommander", "simonklee"],
  desktop_web: ["Hona", "Brendonovich"],
  core: ["jlongster", "rekram1-node", "neriousy", "nexxeln", "kitlangton"],
  inference: ["fwang", "MrMushrooooom", "starptech"],
  windows: ["Hona"],
} as const

function pick<T>(items: readonly T[]) {
  return items[Math.floor(Math.random() * items.length)]!
}

function getIssueNumber() {
  const issue = parseInt(process.env.ISSUE_NUMBER ?? "", 10)
  if (!issue) throw new Error("ISSUE_NUMBER env var not set")
  return issue
}

async function githubFetch(endpoint: string, options: RequestInit = {}) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(options.headers instanceof Headers ? Object.fromEntries(options.headers.entries()) : options.headers),
    },
  })
  if (!response.ok) throw new Error(`GitHub API error: ${response.status} ${response.statusText}`)
  return response.json()
}

interface PR {
  title: string
  html_url: string
}

export default Plugin.define({
  id: "opencode.github.tools",
  setup: async (ctx) => {
    await ctx.tool.transform((tools) => {
      tools.add({
        name: "github-triage",
        options: { codemode: false },
        description: `Use this tool to assign a GitHub issue.

Provide the team that should own the issue. This tool picks a random assignee from that team and does not apply labels.`,
        input: Schema.Struct({
          team: Schema.Literals(Object.keys(TEAM) as [keyof typeof TEAM, ...(keyof typeof TEAM)[]]).annotate({
            description: "The owning team",
          }),
        }),
        execute: async ({ team }) => {
          const issue = getIssueNumber()
          const assignee = pick(TEAM[team])
          await githubFetch(`/repos/anomalyco/opencode/issues/${issue}/assignees`, {
            method: "POST",
            body: JSON.stringify({ assignees: [assignee] }),
          })
          return { content: `Assigned @${assignee} from ${team} to issue #${issue}` }
        },
      })

      tools.add({
        name: "github-pr-search",
        options: { codemode: false },
        description: `Use this tool to search GitHub pull requests by title and description.

This tool searches PRs in the anomalyco/opencode repository and returns LLM-friendly results including:
- PR number and title
- Author
- State (open/closed/merged)
- Labels
- Description snippet

Use the query parameter to search for keywords that might appear in PR titles or descriptions.`,
        input: Schema.Struct({
          query: Schema.String.annotate({ description: "Search query for PR titles and descriptions" }),
          limit: Schema.Number.annotate({ description: "Maximum number of results to return" }).pipe(
            Schema.withDecodingDefaultKey(Effect.succeed(10)),
          ),
          offset: Schema.Number.annotate({ description: "Number of results to skip for pagination" }).pipe(
            Schema.withDecodingDefaultKey(Effect.succeed(0)),
          ),
        }),
        execute: async ({ query, limit, offset }) => {
          const page = Math.floor(offset / limit) + 1
          const searchQuery = encodeURIComponent(`${query} repo:anomalyco/opencode type:pr state:open`)
          const result = await githubFetch(
            `/search/issues?q=${searchQuery}&per_page=${limit}&page=${page}&sort=updated&order=desc`,
          )

          if (result.total_count === 0) return { content: `No PRs found matching "${query}"` }
          const prs = result.items as PR[]
          if (prs.length === 0) return { content: `No other PRs found matching "${query}"` }
          return {
            content: `Found ${result.total_count} PRs (showing ${prs.length}):\n\n${prs.map((pr) => `${pr.title}\n${pr.html_url}`).join("\n\n")}`,
          }
        },
      })
    })
  },
})
