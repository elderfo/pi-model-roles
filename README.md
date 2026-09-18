# pi-model-roles

Assign models to **roles**, not to individual agents.

Instead of pinning a model id in ten different places — your default, each
subagent definition, each spawn call — you keep one table:

```
@default   → anthropic/claude-sonnet-4-5
@smol      → anthropic/claude-haiku-4-5      (fallback: openai/gpt-4.1-mini)
@slow      → anthropic/claude-opus-4-5:high
@designer  → @slow
```

…and everything else refers to roles. Swap the model behind `@smol` once and
every scout, every recon spawn, every cheap lookup follows.

This is the [Oh My Pi](https://omp.sh) `modelRoles` idea rebuilt on
[pi](https://github.com/earendil-works/pi)'s public extension API. Pi has no
role concept of its own — it has `defaultModel`, `enabledModels`, and per-agent
frontmatter, and nothing that ties them together.

> **Docs in Vietnamese:** [README.vi.md](README.vi.md)

---

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [Roles](#roles)
- [Configuration](#configuration)
  - [File locations and precedence](#file-locations-and-precedence)
  - [Selector grammar](#selector-grammar)
  - [Fallback chains](#fallback-chains)
  - [Aliases](#aliases)
  - [Full key reference](#full-key-reference)
- [The `/roles` TUI](#the-roles-tui)
- [Commands](#commands)
- [Subagent integration](#subagent-integration)
- [The advisor](#the-advisor)
- [Compaction](#compaction)
- [How it works](#how-it-works)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Compared to OMP](#compared-to-omp)
- [License](#license)

---

## Install

Requires pi `>= 0.85.0`.

**As a pi package (recommended)**

```bash
pi install git:github.com/thucpru/pi-model-roles
```

Project-local instead of global:

```bash
pi install -l git:github.com/thucpru/pi-model-roles
```

**As a plain global extension**

```bash
git clone https://github.com/thucpru/pi-model-roles \
  ~/.pi/agent/extensions/model-roles
```

Pi auto-discovers `~/.pi/agent/extensions/*/index.ts` — nothing else to do.

**Try it for one session, without installing**

```bash
pi -e /path/to/pi-model-roles
```

> Pick **one** of these. Installing the package *and* cloning into
> `~/.pi/agent/extensions/` loads the extension twice, which registers `/roles`
> twice and stamps subagent models twice.

**Uninstall**

```bash
pi remove git:github.com/thucpru/pi-model-roles   # package install
rm -rf ~/.pi/agent/extensions/model-roles          # manual install
```

Your `model-roles.json` is left in place; delete it by hand if you want a clean
slate.

## Quick start

```bash
pi
```

```
/roles
```

Pick a role, pick a model, add a fallback, done — the table is written to
`~/.pi/agent/model-roles.json` as you go.

Then, from anywhere:

```
/role slow        # switch this session to @slow's model and thinking level
/role             # list every role and what it currently resolves to
/advisor on       # turn on the supervisor (needs @advisor assigned first)
```

Prefer editing JSON? Copy [`model-roles.example.json`](model-roles.example.json)
to `~/.pi/agent/model-roles.json` and adjust.

## Roles

Ten built-in roles. All of them are optional — an unassigned role simply falls
through to `@default`.

| Role | Intended for |
| --- | --- |
| `@default` | The main session. Your everyday driver. |
| `@smol` | Cheap and fast: scouting, greps, file recon, "what does this do". |
| `@slow` | Deep reasoning: hard debugging, architecture, tricky refactors. |
| `@vision` | Image and screenshot analysis. |
| `@plan` | Brainstorming and planning. |
| `@designer` | Frontend design, UI/UX work. |
| `@commit` | Git work: commit messages, diff review, PR bodies. |
| `@tiny` | Micro tasks: summarization, classification, naming. |
| `@task` | Default executor for delegated subagents. |
| `@advisor` | The supervisor that reviews turns and routes work. |

Create your own from the TUI or by adding a key under `roles`. Custom roles
behave identically to built-ins and are the only ones the TUI will delete.

## Configuration

### File locations and precedence

| Scope | Path |
| --- | --- |
| Global | `~/.pi/agent/model-roles.json` |
| Project | `<cwd>/.pi/model-roles.json` |

The project file is merged on top of the global one **per role** and **per agent
mapping** — a project can override `@slow` alone and inherit everything else. A
project file is only read once the project is trusted by pi.

The TUI writes to whichever scope `💾 Save to:` shows; toggle it from the main
menu.

A malformed config is ignored rather than fatal: pi still starts, and roles read
as unset.

### Selector grammar

Every `model` and every `fallback` entry is a **selector**:

| Form | Example | Matches |
| --- | --- | --- |
| `provider/id` | `anthropic/claude-opus-4-5` | exactly that model |
| bare id | `gpt-5.2` | that model id under any provider |
| fuzzy | `haiku` | first available model whose `provider/id` or display name contains it |
| alias | `@slow` | whatever `@slow` resolves to |

Any form may carry a thinking suffix: `:off`, `:minimal`, `:low`, `:medium`,
`:high`, `:xhigh`, `:max`.

```jsonc
"slow": { "model": "anthropic/claude-opus-4-5:high" }
```

Resolution order is exact `provider/id` → exact id → fuzzy on `provider/id` →
fuzzy on display name, and only models your account can actually use are
considered.

### Fallback chains

`fallback` is an ordered list tried after `model`. The first entry that resolves
to an available model wins.

```jsonc
"slow": {
  "model": "anthropic/claude-opus-4-5",
  "thinking": "high",
  "fallback": ["openai/gpt-5.2:high", "@default"]
}
```

A dead provider, an expired key, or a model that vanished from the catalog
degrades the role instead of breaking it. The TUI marks a role using a fallback
with `◐`.

If nothing in the chain resolves, the role falls through to `@default` once, and
the TUI marks it `✗` so you can see the table is lying to you.

### Aliases

A selector starting with `@` points at another role:

```jsonc
"designer": { "model": "@slow" },
"plan":     { "model": "@slow:medium" }
```

The alias inherits the target's model. A thinking suffix on the *referring*
entry wins, so `@plan` above runs the `@slow` model at `medium` while `@slow`
itself stays at `high`. Cycles are detected and terminate instead of recursing.

### Full key reference

```jsonc
{
  "roles": {
    "<name>": {
      "model": "provider/id | id | fuzzy | @role",   // optional
      "thinking": "off|minimal|low|medium|high|xhigh|max", // optional
      "fallback": ["selector", "..."],               // optional, ordered
      "description": "shown in the TUI and to the advisor" // custom roles only
    }
  },

  // subagent definition name -> role name
  "agentRoles": { "scout": "smol", "worker": "task" },

  "advisor": {
    "enabled": false,          // master switch
    "everyTurns": 1,           // review every N completed turns
    "mode": "advise",          // "advise" | "steer"
    "minSeverity": "concern",  // "note" | "concern" | "blocker"
    "maxNotes": 3              // cap on notes and delegation items per review
  },

  // append a role cheat-sheet to the system prompt so the model can use @aliases
  "injectPrompt": true,

  // role that summarizes on compaction; null leaves pi's default alone
  "compactionRole": null
}
```

## The `/roles` TUI

```
Model roles   ● primary  ◐ fallback in use  ✗ broken  ○ unset

● default    anthropic/claude-sonnet-4-5
◐ smol       openai/gpt-4.1-mini (fallback #1)   [+1 fallback]
● slow       anthropic/claude-opus-4-5:high
✗ vision     unresolved
○ commit     — not set —
● designer   openai/gpt-5.2:high via @slow
＋ Create a custom role…
⇄ Agent → role mapping…
⚙ Advisor  (off)…
💾 Save to: global  (~/.pi/agent/model-roles.json)
📝 Role cheat-sheet in system prompt: on
🗜 Compaction summariser: pi default
✕ Close
```

**Status markers**

| Marker | Meaning |
| --- | --- |
| `●` | the primary model resolved |
| `◐` | the primary failed; a fallback is carrying the role |
| `✗` | nothing in the chain resolves — the role silently borrows `@default` |
| `○` | nothing configured |

**Role menu** — select any role to get:

| Action | Notes |
| --- | --- |
| Set primary model | opens the model picker |
| Set thinking level | or `(inherit — let pi decide)` |
| Add fallback model | appended to the end of the chain |
| Remove a fallback | only shown when the role has one |
| Promote a fallback to first | makes it the primary; the old primary becomes fallback #1 |
| Clear primary model | keeps the fallbacks |
| Use this role in the current session | same as `/role <name>` |
| Delete this role | custom roles only; also unmaps any agent pointing at it |

**Model picker** asks for a filter string first (empty lists everything), then
shows only models your account can use, tagged `[reasoning]` and `[vision]`.
`✎ Type a selector or @alias manually…` accepts anything the picker cannot
express — fuzzy patterns, `@aliases`, models not yet in the catalog.

**Agent → role mapping** lists every subagent definition it can find — from
`~/.pi/agent/agents/`, `<cwd>/.pi/agents/`, and the `agents/` folder inside
installed pi packages — plus any agent already named in your config. Map each to
a role, unmap to fall back to `@task`, or add a name by hand.

**Advisor** sub-menu covers the master switch, the advisor model, mode, review
interval, minimum severity and note cap. See [The advisor](#the-advisor).

The TUI is built on `ctx.ui.select` / `input` / `confirm`, so it works in the
interactive TUI and in RPC mode alike.

## Commands

| Command | What it does |
| --- | --- |
| `/roles` | Open the full configuration TUI |
| `/role` | List every role and the model it currently resolves to |
| `/role <name>` | Switch this session to that role's model and thinking level |
| `/advisor` | Show advisor status |
| `/advisor on` \| `/advisor off` | Toggle the advisor and persist it |

`/role` changes are session-scoped: pi records them in session history and
restores them on resume, but your configured `defaultModel` is untouched.

## Subagent integration

One `tool_call` hook covers every spawn tool in the ecosystem:

| Tool | From |
| --- | --- |
| `subagent` | [pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents) |
| `agent` | `@xynogen/pix-subagent` |
| `subagent_delegate` | `@d3ara1n/pi-subagent` |
| `subagent_run` | `pi-subagents-j0k3r` |
| `task` | generic |

**How the model is chosen**

| The call says | What happens |
| --- | --- |
| no `model` | the role mapped to that agent in `agentRoles`, else `@task` |
| `model: "@slow"` | that role |
| `model: "@slow:medium"` | that role at `medium` |
| `model: "anthropic/claude-opus-4-5"` | left alone — an explicit model is the caller's decision |

For `subagent`, the resolved value is written as `provider/id:thinking`, which
is what its `--model` passthrough expects. For tools with a separate `thinking`
parameter, the level is set there instead and the model stays bare.

**This also overrides an agent definition's frontmatter `model:`.** That is
usually what you want: `pi-interactive-subagents` ships `scout`, `researcher`
and `worker` pinned to `openrouter/z-ai/glm-5.3`, which fails outright if you do
not have that provider. Map them to roles once and they run on models you
actually have.

**Letting the model use aliases directly.** With `injectPrompt: true` (the
default), a short cheat-sheet is appended to the system prompt:

```
## Model roles
When you spawn a subagent you may pass a role alias as the model, e.g.
`subagent({ agent: "scout", model: "@smol", task: "..." })`. Omit the model and the
agent's mapped role is used automatically. Available roles:
- @smol: Cheap and fast — scouting, greps, recon (anthropic/claude-haiku-4-5)
- @slow: Deep reasoning, hard debugging, architecture (anthropic/claude-opus-4-5:high)
...
```

Only roles that actually resolve are listed, so the model is never told about a
role it cannot use. Turn it off from the TUI if you are tight on prompt budget.

## The advisor

`@advisor` is a second model that reads each completed turn and answers three
questions: is the primary agent on track, what is it missing, and **which
subagent should take the next chunk of work, on which role's model**.

It is off by default. Assign a model to `@advisor`, then `/advisor on`.

**What it sees**

- the user's prompt for the current turn
- the assistant text from the turn that just ended
- a truncated summary of that turn's tool calls
- the live role table, with what each role resolves to
- the live agent roster, with each agent's description, tools, and mapped role

**What it returns** — strict JSON, parsed defensively (fenced blocks and
surrounding prose are tolerated, malformed replies are dropped):

```json
{
  "severity": "ok | note | concern | blocker",
  "summary": "one sentence on the state of the work",
  "notes": ["specific, actionable observations"],
  "delegate": [
    { "agent": "scout", "role": "smol", "task": "self-contained prompt", "why": "one line" }
  ]
}
```

**What you see** — the verdict is rendered and steered into the session:

```
**Advisor (concern)** — The auth refactor is proceeding without checking callers.

- src/auth/session.ts changed shape; 4 call sites were not visited.

Dispatch these now:
- `subagent({ agent: "scout", model: "@smol", task: "List every call site of createSession" })`
  → @smol = anthropic/claude-haiku-4-5 · recon is cheap, run it in parallel
```

**Three tiers, no tier overreaching**

```
advisor      decides WHO      (which agent, which role)
role table   decides ON WHAT  (role → concrete model)
main agent   decides WHETHER  (it makes the actual tool call)
```

The advisor never spawns anything itself. It names the agent; the `tool_call`
hook stamps the role's model when the main agent acts on it.

**Modes**

- `advise` — report findings and a suggested plan; the main agent decides.
- `steer` — same, plus an instruction to dispatch in the current turn.

**Cost control.** Reviews are throttled by `everyTurns`; verdicts below
`minSeverity` are computed but not injected; `maxNotes` caps notes and
delegation items; turns that produced neither assistant text nor tool calls are
skipped without a call; reviews never overlap; and a failed review degrades to a
warning instead of interrupting the session.

Because reviews run on `turn_end`, an enabled advisor adds one model call per
reviewed turn and delays the next turn by its latency. Start with
`everyTurns: 2` and `minSeverity: "concern"` if that matters to you.

## Compaction

`compactionRole` hands context summarization to a cheaper role:

```jsonc
"compactionRole": "tiny"
```

`null` (the default) leaves pi's built-in compaction untouched. On any failure —
no model, empty summary, request error — it silently falls back to pi's default
rather than losing the summary.

## How it works

Five public pi extension hooks, no patching:

| Hook | Used for |
| --- | --- |
| `session_start` | reload the config for the session's cwd |
| `before_agent_start` | capture the user prompt; append the role cheat-sheet to the system prompt |
| `tool_call` | rewrite `input.model` on spawn tools (`event.input` is mutable) |
| `session_before_compact` | summarize with `compactionRole`'s model |
| `turn_end` | run the advisor review and steer the verdict back in |

Plus `pi.registerCommand`, `pi.setModel` / `pi.setThinkingLevel`,
`ctx.modelRegistry` for the catalog and for `complete()` calls, and
`pi.sendMessage` for the advisor injection.

**Layout**

| File | Responsibility |
| --- | --- |
| `types.ts` | types, constants, defaults — no pi or fs imports |
| `config.ts` | file locations, merging, atomic writes |
| `resolve.ts` | role → model resolution: aliases, fallbacks, matching, health |
| `agents.ts` | subagent definition discovery across user/project/package dirs |
| `ui.ts` | the `/roles` menu tree |
| `advisor.ts` | advisor prompt, JSON parsing, verdict rendering |
| `index.ts` | hooks, commands, and the wiring between them |

## Limitations

- **`@tiny` has few consumers.** Pi calls no background model for session
  titles, memory, or auto-thinking classification, so `@tiny` only does
  something automatically when `compactionRole` points at it. In OMP, `tiny`
  covers all of those. It remains usable via `@tiny` on spawns and `/role tiny`.
- **`@vision` is a label, not a router.** Nothing inspects your attachments and
  switches models for you; use it explicitly.
- **`@commit` is a label too.** Pi has no git-specific model hook. Use
  `/role commit` before git work, or map a git-focused agent to it.
- **Spawn stamping needs a spawn tool.** With no subagent extension installed,
  the `tool_call` hook never fires.
- **`pi-interactive-subagents` requires tmux.** That is its constraint, not this
  extension's.

## Troubleshooting

**`/roles` does not exist.** The extension is not loading. Check that the path
is `~/.pi/agent/extensions/<dir>/index.ts` (or that the package is listed in
`pi list`), and that a project-local install has been trusted.

**A role shows `✗ broken`.** Nothing in its chain matches an available model.
Run `/role` to see the whole table, and check `pi --list-models` — a selector
that was fine yesterday breaks when a provider key expires.

**A role shows `◐`.** The primary is unavailable and a fallback is carrying it.
Usually an auth or catalog problem with the primary provider.

**Subagents still run on the wrong model.** The call passed an explicit concrete
model, which is deliberately left alone. Either drop the `model` argument or
pass `@role`.

**The model does not know about `@aliases`.** `injectPrompt` is off, or every
role is unset so the cheat-sheet is empty.

**The advisor never says anything.** It is off (`/advisor` to check), has no
resolvable model, `everyTurns` has not elapsed, or its verdicts are below
`minSeverity`.

**Everything loads twice.** You installed the package *and* cloned into
`~/.pi/agent/extensions/`. Remove one.

## Development

```bash
git clone https://github.com/thucpru/pi-model-roles
cd pi-model-roles
npm test          # node --test --experimental-strip-types test/*.test.ts
pi -e .           # run a pi session with this checkout loaded
```

Requires Node 22+ for native TypeScript stripping in tests. `resolve.ts` and
`types.ts` are deliberately free of pi imports so the resolution logic is
testable without a pi runtime.

There is no build step — pi loads TypeScript through
[jiti](https://github.com/unjs/jiti).

## Compared to OMP

| | OMP | pi-model-roles |
| --- | --- | --- |
| Config | `modelRoles` in `~/.omp/agent/config.yml` | `~/.pi/agent/model-roles.json` |
| Roles | default, smol, slow, vision, plan, commit, tiny, task, advisor | the same, plus `designer`, plus custom |
| Custom roles | `modelTags` | first-class, created and deleted from the TUI |
| Fallback chains | — | ordered, with health reporting |
| Aliases | `@role`, `*` for default | `@role` |
| Thinking suffix | `:high` etc. | the same |
| Env / flags | `PI_SMOL_MODEL`, `--smol`, `--slow`, `--plan` | — (use `/role`) |
| `tiny` background tasks | titles, memory, auto-thinking, stop detection | compaction only — pi exposes no hook for the rest |
| Advisor | built in, with `WATCHDOG.md` | included, with role-aware delegation planning |
| Project scope | `modelRoleStorage: project` | `<cwd>/.pi/model-roles.json` |

## License

MIT — see [LICENSE](LICENSE).
