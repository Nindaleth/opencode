# Subagent Cost Summary Design

## Goal

Show the total cost of a parent session together with its own cost, the cost of all delegated work, and the number of delegated tasks.

## Current State

The TUI stores cost on each session as `session.cost`. The prompt footer in `packages/tui/src/component/prompt/index.tsx` and the context sidebar in `packages/tui/src/feature-plugins/sidebar/context.tsx` each display only the current session's value.

Subagent sessions already form a tree through `parentID`, and the TUI sync state contains all sessions needed to traverse that tree. No server, API, SDK, database, or persisted-session change is necessary.

## Desired Behavior

For a session without descendant sessions, retain the current compact form:

```text
$0.37
```

For a parent session with descendants, display:

```text
$1.42 ($0.37 + $1.05 by 3 tasks)
```

The values mean:

- `$1.42`: the current session cost plus every descendant session cost
- `$0.37`: cost directly attributed to the current session
- `$1.05`: cost attributed to all descendant sessions
- `3 tasks`: count of all descendant sessions

Both delegated cost and task count include direct children and every nested descendant. A descendant with zero recorded cost still counts as a task.

Apply this display in:

- the parent session prompt footer
- the parent session context sidebar

Keep a subagent session's own footer local-only. It continues to show that session's own cost rather than the total for its parent task tree.

## Recommended Design

Create a small shared TUI helper that accepts the current session and the synchronized session list, then returns the formatted cost display.

The helper will:

1. Start with the current session's own `cost`.
2. Collect every session whose `parentID` is the current session or another collected descendant.
3. Sum descendant costs and count descendant sessions.
4. Return the current-session-only currency string when no descendants exist.
5. Otherwise return the total, own cost, delegated cost, and grammatically correct task count.

Use the existing USD currency formatting convention. The helper should produce `1 task` for a single descendant and `N tasks` otherwise.

The prompt footer and sidebar will replace their local cost formatting with this helper, so they always show the same accounting scope and wording.

## Alternatives Considered

### Inline the aggregation in both views

This produces a small immediate diff but duplicates recursive tree traversal and formatting logic. The two cost displays could drift over time.

Rejected in favor of one shared helper.

### Add aggregate fields to the server API

This would make the summary available to other clients, but it expands the public protocol and requires server-side lifecycle decisions. The TUI already has the complete session tree.

Rejected as unnecessary scope for this display-only change.

### Count only direct children

This mirrors current child navigation, but it makes the displayed task count cover a narrower set than the delegated-cost figure.

Rejected because cost and count must describe the same full descendant tree.

## File-Level Changes

### Shared TUI cost-display helper

Add a focused helper near the existing TUI session utilities. It owns descendant discovery, aggregate calculation, USD formatting, and singular/plural task wording.

### `packages/tui/src/component/prompt/index.tsx`

Replace the current direct `session.cost` formatting in the usage memo with the shared display helper. Context-token rendering stays unchanged.

### `packages/tui/src/feature-plugins/sidebar/context.tsx`

Replace the direct `session.cost` formatting with the same helper while retaining the sidebar's `spent` suffix.

### TUI tests

Add focused unit coverage for the helper:

1. a session with no descendants renders only its own cost
2. direct descendants contribute cost and count
3. nested descendants contribute cost and count
4. zero-cost descendants are included in task count
5. a single descendant uses `1 task`

## Error Handling And Edge Cases

- Missing session data renders no cost, matching the existing views.
- Missing or zero `cost` is treated as zero, matching current session-cost behavior.
- Session records with an unknown parent are ignored unless reachable from the current session.
- A malformed cycle in `parentID` must not double-count or recurse forever; traversal tracks visited session IDs.

## Scope

This is a TUI-only presentation change. It does not alter session accounting, persistence, APIs, subagent creation, or subagent footer behavior.
