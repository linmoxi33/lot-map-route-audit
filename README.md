# lot-map-route-audit

Find Claude Code tool calls that **lot-map never actually classified**: the ones that fall through its `classify()` switch into the generic `shell` branch, so the map lights "Shell" for work that is not the shell.

Why now: lot-map is a fast-moving Claude Code plugin (685★) whose station routing is a hand-written `switch`. Claude Code ships new built-in tools faster than that switch grows, and the miss is silent — the output looks exactly like a real shell route.

Upstream: https://github.com/alexeyw/lot-map

## What upstream does, and what it misses

lot-map draws a live map of a Claude Code session: every tool call is routed to one of ten stations (`you`, `model`, `memory`, `files`, `shell`, `web`, `browser`, `agents`, `skills`, `hooks`) by `hooks/classify.ts`. The classifier names a fixed set of tools and then has one catch-all:

```ts
// hooks/classify.ts, line 271, commit d3102bf
if (mcp === null) return { station: 'shell', label: tool }
```

Any built-in tool the switch does not name lands on **Shell**, with its own name as the label. Upstream knows this is incomplete: issue [alexeyw/lot-map#51](https://github.com/alexeyw/lot-map/issues/51) lists 33 built-in tool names that land there, and proposes a station for 31 of them (the two worktree tools are meant to stay on Shell). That issue is open as of 2026-11-13; the code at [`classify.ts#L271`](https://github.com/alexeyw/lot-map/blob/d3102bf5f16d13b1a3061eb6e63ab10c27e6907d/hooks/classify.ts#L271) is the default branch.

The hard part is not listing names — it is proving a routing decision was a **default** and not a classification. Output alone cannot tell you: `TaskCreate` and `Bash` both return `station: "shell"`.

## What this tool does

`lot-map-route-audit` executes lot-map's **real `classify()`** (the vendored file is upstream's, byte-identical, MIT) and audits a JSONL stream of Claude Code hook events:

1. Runs `classify(tool_name, tool_input)` and records the station.
2. Re-runs it with `tool_input = {}`. If both runs return `{"station":"shell","label":<tool name>}`, no input field was read and no rule matched — that is a **silent fallback**, proven by input perturbation rather than by a hardcoded list.
3. Minimises the witness: it starts from the real input and greedily deletes keys while the fallback still reproduces. The surviving object is the 1-minimal witness (usually `{}` — proof that zero fields matter).
4. Groups fallbacks by tool, with call counts and first/last real event timestamps.

It answers one question: *which tool calls did lot-map route by accident?* It does **not** decide which station a tool should have — that is a design choice, and upstream is discussing it.

## 本轮创新

First tool to treat lot-map's routing as a **runtime contract** instead of a name list: it executes the upstream classifier and separates a real `shell` classification from the default branch using an **input-perturbation differential** (`tool_input` vs `{}`) plus a **1-minimal witness**. A static linter over `classify.ts` cannot make that distinction, and neither can the map's output. Reproducible result at commit `d3102bf`: **33 of the 33 tool names quoted in issue #51 hit the default branch** (31 proposed to move, 2 intentionally kept on Shell) — the fallback is still unconditional in every case. See `examples/in/issue51-names.jsonl` and run it yourself.

## Install

Requirements: Node.js **>= 22.18** (native TypeScript type stripping; tested on Node 24.19.0). No dependencies, no build step, no network.

```bash
git clone https://github.com/linmoxi33/lot-map-route-audit.git
cd lot-map-route-audit
node bin/lot-map-route-audit.mjs --events examples/in/session.jsonl --json
```

Expected: exit code **1**, two findings (`EnterPlanMode`, `TaskCreate`), three silent-fallback events out of eight. Without `--json`, one line per finding.

## Usage

```bash
node bin/lot-map-route-audit.mjs --events <file|-> [--classify <classify.ts>] [--json]
```

- `--events` — JSONL, one Claude Code hook event per line. Required fields: `tool_name`; optional `tool_input` (object), `timestamp` or `ts` (string). Both `PreToolUse` and `PostToolUse` events work; only `tool_name`/`tool_input` are read.
- `--classify` — path to a lot-map `hooks/classify.ts`. Defaults to the vendored, hash-pinned snapshot.
- `--json` — one JSON document on stdout. All diagnostics go to stderr.

`--json` example (`examples/out/report.json`, reproducible byte for byte):

```json
{
  "schema_version": 1,
  "tool": "lot-map-route-audit",
  "classifier": { "file": "lot-map-classify.ts", "sha256": "5325119d..." },
  "totals": {
    "events": 8,
    "stations": { "shell": 4, "files": 1, "web": 2, "skills": 1 },
    "silent_fallback_events": 3,
    "tools_with_silent_fallback": 2
  },
  "findings": [
    { "tool": "TaskCreate", "calls": 2, "first_seen": "...", "last_seen": "...",
      "witness": {}, "station": "shell", "witness_keys": [] }
  ]
}
```

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Events parsed; no silent fallback found |
| `1` | At least one silent fallback found |
| `2` | Usage error, unreadable classifier, unreadable events, invalid JSON, missing `tool_name` |

## Tests

```bash
node tests/run.mjs
```

17 cases, no test framework: 15 behavioural (subprocess exit codes and JSON output), plus a syntax check and a pinned-hash check. Last run: **17 passed, 0 failed**.

## Differences from similar projects

I searched before writing (`gh search repos "claude code hooks"`, `"claude code plugin"`, `"claude code tool call classification"`, `gh search code "classify(tool"`). The hooks ecosystem has observers and dashboards (`disler/claude-code-hooks-multi-agent-observability`, 1,568★), and lot-map itself draws the map. None of them audit *lot-map's classifier decisions* or distinguish a default fallback from a real route. This tool is not a dashboard: it emits a machine-checkable report with a witness and an exit code for CI.

## Limitations

- **Station intent is not judged.** A fallback is not automatically a bug: `EnterWorktree`/`ExitWorktree` are meant to be Shell. The report says "this decision used the default branch", nothing more.
- **Default `Setup` only.** Memory servers/commands/paths are empty, so a user-configured lot-map may route some paths differently. Pass a classifier only for code changes; option-dependent routing is out of scope.
- **Built-in tools only.** MCP tools (`mcp__server__tool`) have their own documented fallback to `web` and are not reported.
- **Hook-event shape, not full transcripts.** Claude Code transcript JSONL (assistant `tool_use` blocks) must be converted to `{tool_name, tool_input}` first.
- The vendored classifier is a snapshot pinned to commit `d3102bf` (2026-11-12). Re-sync it with `scripts/sync-classifier.sh` and re-run the tests; the hash test will fail until the pinned value is updated on purpose.
- Windows path handling is inherited from upstream, not separately tested here.

## License

MIT. `vendor/lot-map-classify.ts` is © 2026 Aleksei Volodin, copied verbatim from [alexeyw/lot-map](https://github.com/alexeyw/lot-map) under the MIT license; see `vendor/LICENSE.lot-map`.
