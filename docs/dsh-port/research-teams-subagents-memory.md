# DSH primitives: subagents, agent teams, cross-session memory

Read-only survey supporting a re-point of gstack skill prose at native DSH
primitives. Target: DSH `0.2.0-rc.2`, profile `web`, active agent preset
`standard`. Verified 2026-10-01.

**LIVE** = read from the running host via `cordis_inspect_query(platform=host, provider=<Service|Config|Tool>, method=...)`. `Tool.listTools` returns every schema "currently callable by this Agent", so it is **scoped to the calling agent**. **SRC** = installed package source. Instance dirs carry hash suffixes; the aliases below resolve them.

| Alias | Path |
| --- | --- |
| `$MISE` | `/home/matt/.local/share/mise/installs/npm-deepseek-ai-dsh/0.2.0-rc.2/node_modules/.mise` |
| `$PROF` | `/home/matt/.dsh/profiles/web` |
| `SUB` | `$MISE/@deepseek-ai+dsh-tool-subagent@0.2.0-rc.2_2c1eb84e338d19faf13f218039ffb1f5/node_modules/@deepseek-ai/dsh-tool-subagent` |
| `SUBCTL` | `$MISE/@deepseek-ai+dsh-tool-subagent-control@0.2.0-rc.2_@deepseek-ai+cordis@4.0.4_@deepseek-a_172f04764d8cbe4478899c9e90539e0e/node_modules/@deepseek-ai/dsh-tool-subagent-control` |
| `TEAMTOOL` | `$MISE/@deepseek-ai+dsh-experimental-tool-agent-team@0.2.0-rc.2_1b2d90729b11dfd746801d7c951d954a/node_modules/@deepseek-ai/dsh-experimental-tool-agent-team` |
| `TEAMSVC` | `$MISE/@deepseek-ai+dsh-experimental-agent-team@0.2.0-rc.2_4003ddf54938a0afa3224808f03bc394/node_modules/@deepseek-ai/dsh-experimental-agent-team` |
| `TEAMPROF` | `$MISE/@deepseek-ai+dsh-experimental-agent-team-profile@0.2.0-rc.2_@deepseek-ai+cordis@4.0.4_@_33b4a4114fb7f3cfec40dc6d68be7d1e/node_modules/@deepseek-ai/dsh-experimental-agent-team-profile` |
| `STDPRESET` | `$MISE/@deepseek-ai+dsh-web-app@0.2.0-rc.2_7f16a6384a0d1667b4d05c4259b569e1/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml` |
| `INSTR` | `$MISE/@deepseek-ai+dsh-agent-instructions@0.2.0-rc.2_1d0e75e2e13d11c06f680aedf4fa5f40/node_modules/@deepseek-ai/dsh-agent-instructions` |
| `HERMES` | `/home/matt/DSH/hermes-preset` |

## 1. Subagents — in the tool list; usable by prose alone

**Tool names (LIVE, `Tool.listTools`):** `subagent`, `subagent_fork`,
`send_message`, `interrupt_agent`, `list_agents`, plus `workflow` for scripted
fan-out. All six confirmed present in the model's tool list.

| Tool | Parameters | Notes |
| --- | --- | --- |
| `subagent` | `description` (str, req), `prompt` (str, req), `run_in_background` (bool, opt) | Fresh child; `prompt` must be self-contained. |
| `subagent_fork` | `description`, `prompt` (req), `run_in_background` (opt) | Child seeded with **completed** parent turns, not the in-flight turn. |
| `send_message` | `agent_id` (str, req), `message` (str, req) | Returns `{messageId}` — delivery confirmation, not the answer. |
| `interrupt_agent` | `agent_id` (str, req) | Non-blocking; returns `{accepted}`. Deeper descendants allowed. |
| `list_agents` | `scope`: `children` (default) \| `descendants` | Lists only **continuable** children; one-shot runs are omitted. |

**Continuable / resumable: yes.** Both delegation tools register with
`backgroundMode: continuable` (`STDPRESET:90-102`), so a call returns
`{kind:"continuable", subagentId}` (`SUB:448-462`, `SUB:525-533`) and
`send_message` starts or resumes that child. Direct children "accept
`send_message` in any status"; descendants deeper than 1 accept only
`interrupt_agent` (`SUBCTL/lib/types/list-agents.js:54-55`). One-shot children
cannot be continued and are hidden from discovery (`SUBCTL/lib/types/list-agents.js:29-30`).

**Prose a skill should carry** (mirrors `SUB:399-400`): delegate with `subagent({description, prompt})`, or `subagent_fork` when the subtask builds on this conversation. Both run in the background and return a subagent id. Start independent delegations together in one assistant message and keep working; continue a child with `send_message({agent_id, message})`; collect before finishing. The host republishes this as a prompt section while the tool is mounted (`SUB:576-580`).

```
subagent({description: "Audit auth paths", prompt: "Read src/auth/**. List every
  path that trusts a client-supplied role. Quote file:line. Do not edit."})
subagent_fork({description: "Review my diff", prompt: "Review the working-tree diff."})
send_message({agent_id: "<subagent id>", message: "Now check the OAuth callback."})
```

## 2. Agent teams — bundle enabled, but **not** in a subagent's tool list

| Tool | Parameters | Authority |
| --- | --- | --- |
| `spawn_teammate` | `name` (lower-kebab, req), `description` (req), `prompt` (req), `context`: `fresh`(default)\|`fork` | **Lead only** |
| `send_message` | `target` (member name or `lead`), `message` | any member |
| `list_agents` | none | any member |
| `wait_agent` | `timeout_ms` (10000–3600000, default 30000) | any member |
| `interrupt_agent` | `target` | **Lead only** |
| `team_task_create` | `subject`, `description`, `blocked_by`?, `write_scopes`? | any member |
| `team_task_list` | `status`?, `owner`? (or `unowned`), `ready`?, `cursor`?, `limit`? | any member |
| `team_task_get` | `task_id` | any member |
| `team_task_update` | `task_id`, `expected_revision`, `action`, + action fields | CAS; `reassign` Lead-only |

Registrations: `spawn_teammate` `TEAMTOOL:242-294`; `send_message` `:295-321`;
`list_agents` `:322-330`; `wait_agent` `:331-352`; `interrupt_agent` `:353-365`;
`team_task_create` `:366-400`; `team_task_list` `:401-444`; `team_task_get`
`:445-457`; `team_task_update` `:458-523`. `action` enum (`:475-484`):
`claim | release | edit | set_dependencies | complete | reopen | reassign | delete`.

**Lifecycle rules** (shipped policy `TEAMTOOL:21-27`, plus `TEAMSVC`):

- Members are durable continuable direct children of the Lead; the Lead is the implicit team identity, addressable as `lead` (`TEAMSVC:350-362`).
- Status is `running | inactive | provisioning | failed` (`TEAMTOOL:48-57`). `inactive` means no turn is executing — it does **not** describe success, failure, or waiting; `provisioning`/`failed` describe creation only.
- `wait_agent` observes only changes after the call starts, never wakes a member, and returns `noProgress: {reason:"no-active-peer"}` immediately when no peer is `running`/`provisioning` (`TEAMTOOL:28`, `:343-349`). Canonical order: `list_agents` + `team_task_list` → `send_message` to wake an inactive required member → `wait_agent`; re-list after wakeup or timeout.
- Members share one working directory and filesystem; write scopes are **advisory, not a lock** (`TEAMTOOL:23`). The Lead must wait for required teammates and review the final diff and tests before answering (`:25`,`:27`).
- Caps: `maxMembers: 8`, `maxTasks: 256`, `maxPendingMessagesPerMember: 64`, `maxMessageBytes: 65536` (`TEAMPROF/cordis.patch.yml:20-24`).

**Shared-task board:** tasks are unowned `pending` rows on creation; the workflow
is **list → get → claim with the current revision → work → complete**
(`TEAMTOOL:27`). Mutations are compare-and-set on `expected_revision`
(`:467-471`). A task carries `blockedBy`, optional `ownerName`, derived `ready`,
and `writeScopeWarnings` (`TEAMTOOL:81-120`). Readiness never starts an owner —
wake the member with `send_message`.

```
spawn_teammate({name: "auth-auditor", description: "Audit auth paths",
  prompt: "Read src/auth/**. Report unguarded trust of client role. Do not edit.",
  context: "fresh"})
team_task_create({subject: "Audit auth", description: "Acceptance: every trust
  point listed with file:line.", write_scopes: ["src/auth/"]})
team_task_update({task_id: "<id>", expected_revision: 1, action: "claim"})
wait_agent({timeout_ms: 60000})
team_task_update({task_id: "<id>", expected_revision: 2, action: "complete"})
```

**Provider bundle: `@deepseek-ai/dsh-experimental-agent-team-profile`, enabled** (`$PROF/package.json:18`). Its patch (`TEAMPROF/cordis.patch.yml`) disables the host rows `tool-subagent-control`, `tool-subagent-list-agents`, `tool-subagent`, `tool-subagent-fork` (`:4-14`) and inserts `agent-team` (service), `tool-agent-team` (tools), `ui-agent-team` (`:16-33`). LIVE agreement: `agentTeams` is a live Host Service (`spawnTeammate`, `listMembers`, `createTask`, `waitForChange`, `interrupt`); the Config directory lists `include:agent-team`, `include:tool-agent-team` and `include:preset-standard`; the host rows `include:tool-subagent*` report status `inactive`.

**Critical catch — never write team prose into a skill that may run as a subagent.** `tool-agent-team` installs its tool set only into scopes where `ctx.agentTeams.tryMembership(agent)` resolves (`TEAMTOOL:539-542`), and `tryMembership` returns `undefined` for any provider-owned subagent child (`TEAMSVC:397-430`; exclusions at `:411` and `:420`). A **root** agent (no `parentSession`, no subagent descriptor) resolves to `role: "lead"` (`TEAMSVC:421-426`) and receives the full team set; a **delegated subagent** receives none. This investigation ran as a delegated subagent, and `Tool.listTools` returned the six subagent tools and **no** `spawn_teammate`, `wait_agent` or `team_task_*`, and no `team:policy` prompt section. Which shape a skill sees is a property of the caller's session, not of the skill.

Two open items, each one cheap call from a root session: `cordis_inspect_query(platform=host, provider=Tool, method=listTools, input={})`. (1) Whether a top-level session really exposes `spawn_teammate` et al. — the mechanism says yes, but `listTools` is caller-scoped, so it was not directly observable. (2) Name collision: `tool-agent-team` registers `send_message`, `interrupt_agent` and `list_agents` (`TEAMTOOL:295,322,353`) while the active `standard` preset registers the *same three names* from a different plugin (`STDPRESET:86-89`). The bundle comment claims its disables keep coordination "on the Team tools" (`TEAMPROF/cordis.patch.yml:1-2`), but it disables only the **host** rows, not the preset rows. Which definition wins — and so whether `send_message` takes `target` or `agent_id` — is unverified; check the resolved tool's `description` before writing prose.

## 3. Memory — native is instructions only; a memory *tool* is plugin-provided

**DSH-native, verified.** No native memory package and no native memory tool
exist: nothing matching `*mem*` is installed in `$MISE`, and no `@deepseek-ai/*`
package registers a tool named `memory` (the only `name: 'memory'` hit in the tree
is inside the vendored `@anthropic-ai/sdk` helpers). The native cross-session
mechanism is the instruction-file chain, `@deepseek-ai/dsh-agent-instructions`: it
discovers `AGENTS.md` and `CLAUDE.md` (`INSTR/lib/index.js:17`) from broadest to
most specific, with exactly one user-global file, `$DSH_HOME/AGENTS.md`
(`INSTR/lib/index.js:141`). `~/.dsh/AGENTS.md` does not exist on this machine.
`~/.dsh/memory/` is therefore **only a directory convention** — DSH does not
inject it, watch it, or expose a tool over it. An open upstream feature request
asks for exactly that auto-injection, corroborating the gap:
[deepseek-harness discussion #5333](https://github.com/deepseek-ai/deepseek-harness/discussions/5333).

**What actually injects `~/.dsh/memory/` here** is the local plugin `hermes-memory`
(`HERMES/index.js`), declared as a **Hermes-preset-only** plugin, not a host row
(`HERMES/cordis.patch.yml:81-82`). It resolves the banks under `$DSH_HOME/memory`
(`:57-64`) — `USER.md` = how to work with the user, `MEMORY.md` = durable
technical facts (`:39-42`), `§`-separated entries (`:36`, `:86-100`) — registers a
prompt section `hermes:memory` at order 50 (`:187-208`) and a `memory` tool
(`:215`) whose parameters are `action: read|append|replace|delete` (req),
`bank: user|memory` (req), `text` (append/replace), `match` (replace/delete)
(`:133-159`). Writes are atomic and capped at 8192 bytes per bank, refusing
oversized updates rather than truncating (`:47`, `:115-130`). Being preset-scoped,
the tool is present in Hermes mode and **absent in `standard` mode** — which is
what LIVE `Tool.listTools` shows here: no `memory` tool.

```
memory({action: "append", bank: "memory", text: "Repo X builds with `bun run build`."})
memory({action: "replace", bank: "user", match: "prefers terse output",
        text: "Prefers terse output, with the tradeoff named."})
```

**Third-party candidates — neither is installed.** `$PROF/package.json:4-12` and
the `bundles` list at `:15-28` contain neither; both are additive installs and
both are **plugin-provided**, sourcing the same directory convention rather than
extending a DSH facility.

| | `dsh-claude-mem` | `dsh-auto-memory` |
| --- | --- | --- |
| Package | `@bleed00/dsh-claude-mem` ([npm](https://www.npmjs.com/package/@bleed00/dsh-claude-mem)) / `github:Bleed00/dsh-claude-mem` | `@a9i5k4/dsh-auto-memory` ([npm](https://registry.npmjs.org/@a9i5k4%2Fdsh-auto-memory)) / `github:Aik358/dsh-auto-memory` |
| Claim | Integrates the external **claude-mem** worker over HTTP: query persisted cross-session memory, inject per-project context at session start, save manual memories, drive summarisation | Self-contained **3-tier memory** (user rules → project notes → daily logs, plus reflections) with host-side proactive recall/injection, self-writing, consolidation, skill crystallisation, panel UI |
| Model-facing tools | `mem_search`, `mem_timeline`, `mem_get_observations`, `mem_save`, `mem_context` (+ `mem-search` skill) | `memory_recall`, `memory_read`, `memory_search`, `memory_note`, `memory_consolidate` |
| Host hooks | `agent/session-start` injection; optional `tools/post-execute` ingest; optional `agent/turn-stopping` summarise | Context observer + fixed-boundary injection before the next turn; per-turn extraction subagent; pre-completion interception |
| Storage | The claude-mem worker's own store, **not** `~/.dsh/memory` | `~/.dsh/memory/MEMORY.md`, `~/.dsh/memory/workspaces/{ws}/MEMORY.md`, `.../YYYY-MM-DD.md`, `.../reflections/` — the same directory the local `hermes-memory` already uses |
| Config | `baseUrl` (default `http://127.0.0.1:<37700 + uid%100>`), `timeoutMs`, `dedupe`, `platformSource`, `project`, `injectContext`, `ingest`, `summarize`, `toolFilter.names` | `~/.dsh/dsh-auto-memory.json`: `userMemoryDir`, `memoryRoot`, `injectEnabled`, `injectBudgetChars` (2400), `recentDaysInjected`, `reflectEnabled`, `autoConsolidate*`, `unattendedMode`, `memoryHubEnabled`, `externalSources` |
| Extra dependency | A claude-mem worker running on localhost | Optional `@huggingface/transformers` (~130 MB) semantic tier; optional Python sidecar (~563 MB) |
| Install | `dsh plugin --profile web add github:Bleed00/dsh-claude-mem` | `pnpm add @a9i5k4/dsh-auto-memory@latest` in `$PROF`, append to `dsh.profile.bundles`, **restart `dsh web`** |
| Verified against | dsh `0.1.0-rc.6`, older than the installed `0.2.0-rc.2` | dsh `0.1.0-rc.6`; ~83 stars, BSD-3-Clause, zero runtime deps |

The `dsh-auto-memory` / `hermes-memory` overlap on `~/.dsh/memory/MEMORY.md` is a
real conflict risk if both are ever enabled.

## 4. Prose alone, or configuration required?

| Area | Prose alone? | Requirement |
| --- | --- | --- |
| **Subagents** | **Yes.** | `subagent`, `subagent_fork`, `send_message`, `interrupt_agent`, `list_agents` are in the model's tool list here, delivered by the active agent preset (`STDPRESET:80-102`), not a host row. Describe delegation, background fan-out and continuation freely. |
| **Agent teams** | **Conditionally — never from a subagent.** | Needs the caller's session to be a root agent (implicit Lead) and the `dsh-experimental-agent-team-profile` bundle, which *is* enabled (`$PROF/package.json:18`) and live. A delegated subagent gets no team tools (`TEAMSVC:411`, `:420`). Verify with `Tool.listTools` from the intended caller first. |
| **Memory (native)** | **Prose only, and it is not a tool.** | The sole native path is instruction files: `$DSH_HOME/AGENTS.md` (`INSTR:141`) and the project `AGENTS.md`/`CLAUDE.md` chain (`INSTR:17`). A skill can direct the model to read/write `~/.dsh/memory/*.md` as ordinary files via `read`/`write`/`edit` — that works today — but nothing injects or validates it, and `~/.dsh/AGENTS.md` does not exist here. |
| **Memory (`memory` tool)** | **No.** | Preset-scoped to Hermes (`HERMES/cordis.patch.yml:81-82`); in `standard` mode the tool does not exist, so a skill naming it calls a missing tool. Sharing those banks with `standard` sessions requires a host-level row — host/plugin configuration. |
| **Memory (third-party)** | **No.** | Neither `dsh-claude-mem` nor `dsh-auto-memory` is installed; both need a package install plus bundle registration (`dsh-auto-memory` also a `dsh web` restart). |

**Summary.** Subagents and `send_message` continuation are real, in-list
primitives — write `subagent({description, prompt})` prose freely. Agent teams are
real but only for a root session; never assume `spawn_teammate` exists.
Cross-session memory has **no** native tool: the only zero-config path is reading
and writing `~/.dsh/memory/*.md` as plain files, and every tool-shaped memory
interface here is preset- or plugin-scoped.
