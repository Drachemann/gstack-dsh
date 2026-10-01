# Claude-Code / wrong-host leakage in the generated dsh skill tree

Audit of every generated `SKILL.md` under `/home/matt/src/gstack-dsh/.dsh/skills/`
(rendered by `bun run gen:skill-docs --host dsh`), read-only except for this file.

**Scope correction:** the brief says "57 directories named `gstack-*` (plus `gstack/`) = 58 SKILL.md".
Reality on disk: **56** `gstack-*` directories plus `gstack/` = **57 SKILL.md files**
(`ls -d .dsh/skills/gstack-*/ | wc -l` → 56). Non-SKILL assets in the tree are only
`gstack-qa/sections/*.md`, `gstack-qa/templates/*.md`, `gstack-qa-only/sections/*.md` (10 files).

**Method:** `grep -rEn` per class over `--include=SKILL.md`, counts are *matching lines*
(one line with two hits counts once). `$GSTACK_ROOT/…` counts were re-verified with `grep -rn … | wc -l`.
Judgements: **(a)** harmless prose/example, **(b)** broken at runtime under dsh, **(c)** ambiguous.

**Key environment fact used throughout.** The dsh preamble (lines 21–25 of every skill) sets
`GSTACK_ROOT="$HOME/.dsh/skills/gstack"`, falling back to `$_ROOT/.dsh/skills/gstack`.
That directory contains **only `SKILL.md`** — no `bin/`, `browse/`, `design/`, `lib/`, `scripts/`,
`review/`, `sections/`, `docs/`, `ETHOS.md`, `gstack-upgrade/`. `hosts/dsh.ts` states dsh has
no installer and its `runtimeRoot` block is "documentation-grade", so nothing creates those links.
`~/.dsh/skills/gstack` does not exist at all.

## Count table (class → distinct files → occurrences)

| # | Class | Files | Occ |
|---|---|---|---|
| 1 | Claude-Code MCP registration (`claude mcp add/remove/list`, `--scope user`, `~/.claude.json`) | 1 | 18 |
| 2 | Claude/Codex/Gemini CLI shell-outs (`codex exec`, `codex review`, `claude -p`, `~/.codex`, `CODEX_HOME`) | 50 | 168 |
| 3 | Claude-specific env vars / paths (`CLAUDE_*`, `~/.claude`, `.claude/`) | 9 | 49 |
| 3b | Claude Code hook mechanism (`PreToolUse`, `PostToolUse`) | 41 | 166 |
| 4 | `mcp__<server>__<tool>` tool names | 7 | 14 |
| 5 | CC-only slash/plugin syntax (`/plugin`, `/agents`, `.claude/agents`, `/rewind`, `/checkpoint`) | 2 | 3 |
| 6 | `$GSTACK_ROOT/<asset>` references unresolvable under the dsh install root | 51 | 740 |
| 7 | `$GSTACK_ROOT/bin/<script>` scripts **absent from repo `bin/`** | **0** | **0** |
| E1 | Claude-only tool names / plan lifecycle (`ExitPlanMode`, `subagent_type`, `run_in_background`) | 50 | 142 |
| E2 | Claude-only CLI flags (`--disallowedTools`, `--allowedTools`, `--resume`, `--tools`) | 42 | 51 |
| E3 | Bare `/skill` names that resolve only via the sibling `.agents/skills` render | 55 | 1052 |
| E4 | Claude/Codex binary + artifact names (`CLAUDE_BIN`, `gstack-claude-code`, `RUNTIME_ROOT`) | 9 | 32 |
| E5 | Foreign model ids (`gpt-5.x`, `claude-*`) | 4 | 5 |
| E6 | `allowed-tools` key (CC-only frontmatter/flag vocabulary) | 41 | 44 |

Zero-hit requested patterns: `AskUserQuestion` (rewritten to `ask_user_question`), `CLAUDE.md`
(rewritten to `AGENTS.md`), `.mcp.json`, `mcpServers`, `.claude/agents`, `mcp__claude-in-chrome__*`,
`settings.json` hooks, `statusline`, `claude exec`, `gemini` CLI invocation, `--dangerously-skip-permissions`,
`--permission-mode`, `--append-system-prompt`, `--strict-mcp-config`, `CLAUDE_CONFIG_DIR`, `CLAUDE_PLUGIN_ROOT`.

## Blast-radius ranking (distinct skills affected)

1. **E3** bare `/name` invocation — 55 skills — *(c) ambiguous*: `/ship` works today only because `.agents/skills/` is also loaded and registers `ship`; the dsh render registers `gstack-ship`, so removing `.agents/` breaks every bare invocation.
2. **6** `$GSTACK_ROOT` assets — 51 skills — *(b) broken*: asset dir absent from the dsh install root.
3. **2** cross-host CLI shell-outs — 50 skills — *(b) broken* where executed, *(a)* where boilerplate prose.
4. **E1** Claude-only tool names — 50 skills — *(b) broken* for `ExitPlanMode`/`subagent_type`.
5. **E2** CC-only CLI flags — 42 skills — *(c)* mostly advisory prose inside one repeated block.
6. **3b** hooks — 41 skills — *(a)/(c)*: one repeated 4-line ask_user preamble block; only 2 files carry real behaviour.
7. **E6** `allowed-tools` — 41 skills — *(a)* prose inside the same repeated block.
8. **7** missing `bin/` scripts — 36 skills reference them, but **0 are missing from the repo**.
9. **3** Claude env vars/paths — 9 skills — *(b)* in `gstack-claude-code`/`gstack-codex`, *(a)* elsewhere.
10. **E4** binary/artifact names — 9 skills — *(b)* in `gstack-claude-code`.
11. **4** `mcp__gbrain__*` tool names — 7 skills — *(b)/(c)*: dsh does not expose that naming shape.
12. **E5** foreign model ids — 4 skills — *(a)* prose/citations.
13. **5** CC-only slash/plugin syntax — 2 skills — *(a)* historical note only.
14. **1** `claude mcp` registration — 1 skill — *(b) broken*, highest severity per occurrence.

## Findings by class

### 1 — Claude-Code MCP registration · 1 file / 18 occ · **(b) broken**
Per-file: `gstack-setup-gbrain` 18.

| file:line | matched text | judge |
|---|---|---|
| gstack-setup-gbrain:942 | ``claude mcp add --scope user --transport http gbrain "$MCP_URL" \`` | (b) dsh has no `claude mcp`; no MCP registered |
| gstack-setup-gbrain:967 | `claude mcp add --scope user gbrain -- "$GBRAIN_BIN" serve` | (b) same |
| gstack-setup-gbrain:945 | ``claude mcp list \| grep gbrain  # verify: should show "✓ Connected"`` | (b) verification always empty |
| gstack-setup-gbrain:940 | `claude mcp remove gbrain -s user 2>/dev/null \|\| true` | (b) teardown is a silent no-op |
| gstack-setup-gbrain:840 | `` >   ✅ Zero local state — only `~/.claude.json` MCP registration`` | (b) claims state that dsh never writes |
| gstack-setup-gbrain:1193 | ``in to git in many projects). It lives only in `~/.claude.json` where`` | (c) documents a CC-only token store |

Remaining 12 occurrences are the same mechanism (`claude mcp …`) or `~/.claude.json` prose on
lines 388, 886, 888, 948, 950, 965, 966, 968, 1186, 1194.

### 2 — Claude/Codex/Gemini CLI shell-outs · 50 files / 168 occ · **(b) executed, (a) boilerplate**
Per-file: `gstack-codex` 47, `gstack-spec` 7, `gstack-autoplan` 6, `gstack-benchmark-models` 5,
`gstack-claude-code` 5, `gstack-pair-agent` 4, `gstack-retro` 4, then **43 files at exactly 2**.
The 2-per-file floor is two byte-identical boilerplate lines present in 50 and 49 files:
`In plan mode, allowed because they inform the plan: … codex exec/codex review …` and
`… EXIT PLAN MODE GATE … before ExitPlanMode is called …`.

| file:line | matched text | judge |
|---|---|---|
| gstack-codex:681 | `_gstack_codex_timeout_wrapper 330 codex review --base <base> -c 'sandbox_mode="read-only"' …` | (b) `codex` not installed/owned by dsh |
| gstack-codex:723 | `_gstack_codex_timeout_wrapper 330 codex exec -s read-only "$(cat "$_PROMPT_FILE")" …` | (b) same |
| gstack-ship:2037 | `_gstack_codex_timeout_wrapper 300 codex exec "$_OUTSIDE_PROMPT" -C "$_REPO_ROOT" …` | (b) outside-review path cannot run |
| gstack-document-release:954 | `_gstack_codex_timeout_wrapper 300 codex exec "$_OUTSIDE_PROMPT" …` | (b) same |
| gstack-spec:1030 | `cat "$ARCHIVE_PATH" \| (cd "$SPAWN_PATH" && claude -p 2>&1) &` | (b) spawns the Claude CLI |
| gstack-codex:532 | `set, or `${CODEX_HOME:-~/.codex}/auth.json` exists. Avoids false-negatives for` | (b) probes a foreign host's credentials |

`hosts/dsh.ts` suppresses every `CROSS_MODEL_RESOLVER`, but these blocks were rendered anyway
(they are outside the resolver surface), so the suppression is partial.

### 3 — Claude env vars / paths · 9 files / 49 occ · **(b) 2 files, (a) 7**
Per-file: `gstack-claude-code` 28, `gstack-codex` 9, `gstack-setup-gbrain` 5, `gstack-investigate` 2,
`gstack-benchmark-models` 1, `gstack-document-release` 1, `gstack-review` 1, `gstack-ship` 1, `gstack-spec` 1.

| file:line | matched text | judge |
|---|---|---|
| gstack-claude-code:516 | `CLAUDE_TMP=''` | (b) naming only; the script itself is CC-driven |
| gstack-claude-code:460 | ``with `GSTACK_CLAUDE_BIN` / `CLAUDE_BIN` overrides and their argument prefixes,`` | (b) CC-only binary contract |
| gstack-investigate:450 | `# hooks and early skill bash run before any runtime var like CLAUDE_SKILL_DIR` | (b) `CLAUDE_SKILL_DIR` never exists under dsh |
| gstack-spec:920 | `` `GSTACK_HOME`, `CLAUDE_PLUGIN_DATA`, Windows fallback):`` | (b) CC plugin var |
| gstack-benchmark-models:227 | `[ -n "$ANTHROPIC_API_KEY" ] \|\| grep -q 'ANTHROPIC' "$HOME/.claude/.credentials.json" …` | (b) reads CC credential store |
| gstack-ship:1571 | `for PLAN_DIR in "$HOME/.gstack/projects/$_PLAN_SLUG" "$HOME/.claude/plans" "$HOME/.codex/plans" …` | (c) probe list; degrades harmlessly |
| gstack-review:495 | `for PLAN_DIR in … "$HOME/.claude/plans" "$HOME/.codex/plans" ".gstack/plans"; do` | (c) same |

Nine `~/.claude/` mentions in `gstack-codex`/`gstack-document-release` are inside the injected
"do NOT read files under `~/.claude/`" guard text — (a) harmless, and it actually names `.dsh/skills/` too.

### 3b — Claude Code hook mechanism · 41 files / 166 occ · **(a)/(c)**
Per-file: `gstack-plan-tune` 6, and **40 files at exactly 4**. All 166 hits are the repeated
`ask_user_question` preamble block; there are no `settings.json` hook definitions and no `statusline`.

| file:line (gstack-ship) | matched text | judge |
|---|---|---|
| :309 | `… Without the marker, the PreToolUse hook treats ask_user_question as observed-only and never auto-decides.` | (c) hook never fires under dsh ⇒ auto-decide silently stops working |
| :311 | ``**Embed the option recommendation via the `(recommended)` label suffix** … The PreToolUse hook parses …`` | (c) same |
| :313 | `After answer, log best-effort (PostToolUse hook also captures deterministically when installed; …` | (c) same, explicitly conditional |
| :71 | ``… prose has no PostToolUse hook, so this feeds `/plan-tune` learning.`` | (a) already conditional prose |

### 4 — `mcp__<server>__<tool>` names · 7 files / 14 occ · **(b)/(c)**
Per-file: `gstack-plan-tune` 3; `gstack-office-hours`, `gstack-plan-ceo-review`,
`gstack-plan-design-review`, `gstack-plan-devex-review`, `gstack-plan-eng-review` 2 each;
`gstack-setup-gbrain` 1.

| file:line | matched text | judge |
|---|---|---|
| gstack-plan-ceo-review:2113 | ``typed prediction with `mcp__gbrain__takes_add`; if unavailable, use`` | (c) guarded by "if unavailable" |
| gstack-plan-ceo-review:2114 | `` `mcp__gbrain__put_page` with a gstack:takes fence block.`` | (b) only reachable if the name exists |
| gstack-plan-tune:952 | ``- On `memory-nugget` apply: `mcp__gbrain__put_page` with the nugget +`` | (b) same |
| gstack-setup-gbrain:1269 | `Smoke test: ask the agent to run `mcp__gbrain__search` with any query` | (b) smoke test cannot run |
| gstack-setup-gbrain:979 | ``Claude Code sessions to see `mcp__gbrain__*` tools — they're loaded at`` | (b) describes the CC tool-naming shape |

### 5 — CC-only slash/plugin syntax · 2 files / 3 occ · **(a)**
`/plugin`, `/agents`, `/mcp`, `/hooks`, `.claude/agents` → **0 hits**. Nearest hits are historical notes:

| file:line | matched text | judge |
|---|---|---|
| gstack-context-save:626 | ``name collided with Claude Code's native `/rewind` alias — the rename fixed that.`` | (a) changelog prose |
| gstack-context-save:625 | ``  `/context-save`, invoke this skill via the skill tool. The old `/checkpoint``` | (a) prose |
| gstack-review:1028 | `No second report. Update affected outcomes/checkpoint links through repairs/revalidation.` | (a) false positive ("checkpoint links") |

### 6 — `$GSTACK_ROOT/<asset>` references · 51 files / 740 occ · **(b) broken**
Per-file (top): `gstack-ship` 59, `gstack-autoplan` 44, `gstack-setup-gbrain` 42, `gstack-plan-tune` 36,
`gstack-office-hours` 31, `gstack-plan-devex-review` 29, `gstack-document-release` 26, `gstack-spec` 22,
`gstack-plan-ceo-review` 21, `gstack-plan-eng-review` 20, `gstack-plan-design-review` 20,
`gstack-learn` 19, `gstack-review` 19, `gstack-codex` 18, `gstack-land-and-deploy` 18,
`gstack-sync-gbrain` 16, `gstack-design-review` 16, `gstack-design-html` 15, then 33 more files at 3–14.
Six files carry **zero**: `gstack-careful`, `gstack-cso`, `gstack-deslop-shared-libs`, `gstack-freeze`,
`gstack-guard`, `gstack-unfreeze`.

| file:line | matched text | judge |
|---|---|---|
| gstack-ship:22 | `GSTACK_ROOT="$HOME/.dsh/skills/gstack"` | (b) resolves to a dir holding only SKILL.md |
| gstack-ship:24 | `GSTACK_BIN="$GSTACK_ROOT/bin"` | (b) `bin/` absent ⇒ `GSTACK_BIN` dangling |
| gstack-ship:25 | `GSTACK_BROWSE="$GSTACK_ROOT/browse/dist"` | (b) absent |
| gstack-review:700 | ``Read `$GSTACK_ROOT/review/checklist.md`.`` | (b) hard STOP path — file absent |
| gstack-ship:1902 | ``1. Read `$GSTACK_ROOT/review/checklist.md`. If the file cannot be read, **STOP** and report the error.`` | (b) skill aborts by design |
| gstack-design-review:1072 | `_DUMP=$(cat "$GSTACK_ROOT/lib/dom-dump.js")` | (b) empty capture ⇒ broken evaluate |

### 7 — `$GSTACK_ROOT/bin/<script>` scripts missing from repo `bin/` · **0 files / 0 occ**
All **43** distinct referenced `$GSTACK_ROOT/bin/<script>` paths exist in `/home/matt/src/gstack-dsh/bin/`
(251 references across 36 files). Verified one-by-one. The failure mode is not a missing script —
it is that `$GSTACK_ROOT/bin` itself does not exist under the dsh install root (class 6).
Most-referenced: `gstack-config` 43, `gstack-slug` 38, `gstack-paths` 28, `gstack-review-log` 20,
`gstack-review-read` 17, `gstack-learnings-search` 7, `gstack-redact` / `gstack-issue-guard` /
`gstack-evidence` / `gstack-developer-profile` 6 each. `bin/gstack-claude-code` (referenced via
`$RUNTIME_ROOT/bin/…`) also exists.

### E1 — Claude-only tool names / plan lifecycle · 50 files / 142 occ · **(b)**
`ExitPlanMode` 122 occ / 50 files; `run_in_background` 15 / 6; `subagent_type` 6 / 2;
`EnterPlanMode`, `TaskOutput`, `` `Agent` `` tool-spelling → 0.

| file:line | matched text | judge |
|---|---|---|
| gstack-ship:58 | `… Do not continue the workflow or call ExitPlanMode there. … Call ExitPlanMode only after the skill workflow completes …` | (b) dsh's tool is `exit_plan_mode` |
| gstack-ship:406 | `… which verifies the plan file ends with `## GSTACK REVIEW REPORT` before ExitPlanMode is called.` | (b) plan-review gate blocks on a tool that cannot be called |
| gstack-ship:1133 | `Dispatch the audit through Agent with `subagent_type: "general-purpose"` and` | (b) dsh `subagent` has no `subagent_type` |
| gstack-ship:2595 | `` `subagent_type: "general-purpose"`.`` | (b) same |
| gstack-design-shotgun:746 | ``tool with `subagent_type: "general-purpose"` and `run_in_background: false` for each`` | (b)/(c) `run_in_background` does exist on dsh `subagent` |

### E2 — Claude-only CLI flags · 42 files / 51 occ · **(c)**
`--disallowedTools` 43 occ / 41 files; `--resume` 6 / 4; `--tools` 2 / 1; `--allowedTools` 1 / 1.
The 41-file mass is one line repeated: ``hosts may disable native via `--disallowedTools`; calling native there silently fails``.
`--resume`/`--tools` are real CC CLI shapes in `gstack-cso` and `gstack-claude-code`.

### E3 — Bare `/name` invocations · 55 files / 1052 occ · **(c) ambiguous**
Most-referenced tokens: `/ship` 161, `/gstack-upgrade` 106, `/plan-*-review` 91, `/qa` 73, `/codex` 71,
`/review` 65, `/qa-only` 53, `/office-hours` 43, `/retro` 41, `/document-generate` 41, `/autoplan` 30,
`/browse` 27, `/plan-ceo-review` 19, `/spec` 11. Only `gstack-ship` (etc.) is registered by this tree;
bare `ship` resolves solely because the sibling `.agents/skills/` render (frontmatter `name: ship`)
is also discovered as the `project-agents` root. Delete or exclude that tree and every bare
invocation in this render breaks. `gstack`, `gstack-cso` and the five zero-hit safety skills are
the only files with no bare-name references beyond incidental ones.

### E4 / E5 / E6 — residual wrong-host vocabulary
- **E4** (9 files / 32 occ, **(b)** in `gstack-claude-code`): `RUNTIME_ROOT='<gstack-runtime-root>'`
  is an unfilled placeholder (gstack-claude-code:515, 592, 672) and `CLAUDE_RUNNER="$RUNTIME_ROOT/bin/gstack-claude-code"`
  (:530, :607, :687) is therefore a guaranteed command-not-found.
- **E5** (4 files / 5 occ, **(a)**): `gpt-5.x` citations in `gstack-plan-design-review:1160`,
  `gstack-design-review:1539`, `gstack-codex:1336`; "magnum opus" in `gstack-office-hours:1747,1760`.
- **E6** (41 files / 44 occ, **(a)**): the word `allowed-tools` inside the same repeated AUQ block
  plus `gstack-claude-code` prose. No `allowed-tools` frontmatter is emitted by the dsh render.

## Per-skill grouping

Ranked by total hits across classes 1, 2, 3, 3b, 4, 6, 7, E1, E2:

| skill | 1 | 2 | 3 | 3b | 4 | 6 | 7 | E1 | E2 | total |
|---|---|---|---|---|---|---|---|---|---|---|
| gstack-ship | · | 3 | 1 | 4 | · | 59 | 32 | 13 | 1 | 113 |
| gstack-setup-gbrain | 18 | 2 | 5 | 4 | 1 | 42 | 34 | 2 | 4 | 112 |
| gstack-codex | · | 47 | 9 | 4 | · | 18 | 8 | 5 | 1 | 92 |
| gstack-plan-tune | · | 2 | · | 6 | 3 | 36 | 28 | 2 | 1 | 78 |
| gstack-autoplan | · | 6 | · | 4 | · | 44 | 10 | 6 | 1 | 71 |
| gstack-office-hours | · | 3 | · | 4 | 2 | 31 | 15 | 4 | 1 | 60 |
| gstack-claude-code | · | 3 | 28 | 4 | · | 9 | · | 2 | 4 | 50 |
| gstack-plan-devex-review | · | 2 | · | 4 | 2 | 29 | 6 | 5 | 1 | 49 |
| gstack-plan-eng-review | · | 2 | · | 4 | 2 | 20 | 8 | 11 | 2 | 49 |
| gstack-document-release | · | 3 | 1 | 4 | · | 26 | 8 | 3 | 1 | 46 |
| gstack-plan-ceo-review | · | 2 | · | 4 | 2 | 21 | 7 | 7 | 1 | 44 |
| gstack-spec | · | 7 | 1 | 4 | · | 22 | 5 | 2 | 2 | 43 |
| (all remaining skills) | · | 2 | 0–2 | 4 | · | 4–19 | 0–11 | 2 | 1 | 9–39 |

Repetition profile — three shared preamble/boilerplate blocks explain most volume:
**B1** (50 files) plan-mode allowed-ops line; **B2** (50 files) EXIT PLAN MODE GATE line;
**B3** (41 files × 4 lines) ask_user_question hook/preference block. Fixing the generator's
preamble removes ~90% of classes 2, 3b, E1, E2, E6 by line count.

## `$GSTACK_ROOT`-relative runtime assets referenced (72 distinct paths)

**Missing from the repo: none.** All 72 distinct paths exist under `/home/matt/src/gstack-dsh/`,
and all 43 distinct `bin/` scripts exist in `bin/`. **Missing from the dsh install root: all 72**,
because `.dsh/skills/gstack/` holds only `SKILL.md` and `~/.dsh/skills/gstack` does not exist.

| referenced path | refs | repo | dsh install |
|---|---|---|---|
| `$GSTACK_ROOT/bin` (+ 43 named scripts) | 95 + 251 | ✅ | ❌ |
| `$GSTACK_ROOT/browse/dist` | 50 | ✅ | ❌ |
| `$GSTACK_ROOT/design/dist` | 50 | ✅ | ❌ |
| `$GSTACK_ROOT/scripts/question-registry.ts` | 41 | ✅ | ❌ |
| `$GSTACK_ROOT/scripts/jargon-list.json` | 41 | ✅ | ❌ |
| `$GSTACK_ROOT/docs/askuserquestion-split.md` | 41 | ✅ | ❌ |
| `$GSTACK_ROOT/docs/askuserquestion-cjk.md` | 41 | ✅ | ❌ |
| `$GSTACK_ROOT/ETHOS.md` | 18 | ✅ | ❌ |
| `$GSTACK_ROOT/lib/claude-bin.ts` | 15 | ✅ | ❌ |
| `$GSTACK_ROOT/plan-devex-review/dx-hall-of-fame.md` | 12 | ✅ | ❌ |
| `$GSTACK_ROOT/lib/outside-review-result.ts` | 8 | ✅ | ❌ |
| `$GSTACK_ROOT/docs/test-value-bar.md` | 6 | ✅ | ❌ |
| `$GSTACK_ROOT/browse/bin/remote-slug` | 6 | ✅ | ❌ |
| `$GSTACK_ROOT/office-hours/SKILL.md` | 5 | ✅ | ❌ |
| `$GSTACK_ROOT/review/checklist.md`, `review/TODOS-format.md` | 3 each | ✅ | ❌ |
| `$GSTACK_ROOT/lib/dom-dump.js` | 3 | ✅ | ❌ |
| `$GSTACK_ROOT/review/greptile-triage.md` | 2 | ✅ | ❌ |
| `$GSTACK_ROOT/plan-design-review/SKILL.md` | 2 | ✅ | ❌ |
| `$GSTACK_ROOT/design-html/vendor/pretext.js` | 2 | ✅ | ❌ |
| remaining 30 paths (1 each: `ship/sections/apple-release.md`, `plan-eng-review/sections/review-sections.md`, `lib/review-evidence.ts`, `lib/redact-audit-log.ts`, `design-html/sections/detector-install-offer.md`, `review/design-checklist.md`, `VERSION`, …) | 1 each | ✅ | ❌ |

Structural note: in a Claude install `$GSTACK_ROOT` is the *bundle* directory with nested skill
dirs (`$GSTACK_ROOT/office-hours/SKILL.md`). The dsh render is **flat** — `gstack-office-hours/`
is a sibling of `gstack/`, not a child — so even the two `$GSTACK_ROOT/<skill>/SKILL.md`
references are structurally unreachable. Skill-local assets that *do* resolve are the relative ones:
`gstack-qa/sections/*.md` and `gstack-qa-only/sections/*.md` exist in-tree (39 relative `sections/`
references are fine), and `gstack-upgrade/SKILL.md:80` correctly sets `INSTALL_DIR="$HOME/.dsh/skills/gstack"`.

## Top 10 concrete runtime-breakers

1. `.dsh/skills/gstack-setup-gbrain/SKILL.md:967` — `claude mcp add --scope user gbrain -- "$GBRAIN_BIN" serve`
2. `.dsh/skills/gstack-setup-gbrain/SKILL.md:942` — `claude mcp add --scope user --transport http gbrain "$MCP_URL" \`
3. `.dsh/skills/gstack-setup-gbrain/SKILL.md:945` — `claude mcp list | grep gbrain  # verify: should show "✓ Connected"`
4. `.dsh/skills/gstack-ship/SKILL.md:22` — `GSTACK_ROOT="$HOME/.dsh/skills/gstack"` (dir has only SKILL.md) + `:24 GSTACK_BIN="$GSTACK_ROOT/bin"`
5. `.dsh/skills/gstack-ship/SKILL.md:1902` — `` 1. Read `$GSTACK_ROOT/review/checklist.md`. If the file cannot be read, **STOP** and report the error.``
6. `.dsh/skills/gstack-claude-code/SKILL.md:530` — `CLAUDE_RUNNER="$RUNTIME_ROOT/bin/gstack-claude-code"` with `:515 RUNTIME_ROOT='<gstack-runtime-root>'`
7. `.dsh/skills/gstack-spec/SKILL.md:1030` — `cat "$ARCHIVE_PATH" | (cd "$SPAWN_PATH" && claude -p 2>&1) &`
8. `.dsh/skills/gstack-ship/SKILL.md:2037` — `_gstack_codex_timeout_wrapper 300 codex exec "$_OUTSIDE_PROMPT" -C "$_REPO_ROOT" -s read-only …`
9. `.dsh/skills/gstack-ship/SKILL.md:58` — `… Do not continue the workflow or call ExitPlanMode there. …` (dsh tool is `exit_plan_mode`)
10. `.dsh/skills/gstack-design-review/SKILL.md:1072` — `_DUMP=$(cat "$GSTACK_ROOT/lib/dom-dump.js")` (empty ⇒ dead page evaluate)

Runners-up: `gstack-ship:1133` `subagent_type: "general-purpose"`; `gstack-benchmark-models:227`
`grep -q 'ANTHROPIC' "$HOME/.claude/.credentials.json"`; `gstack-setup-gbrain:1269` `mcp__gbrain__search`;
`gstack-ship:309` `PreToolUse` auto-decide that can never fire; `gstack-investigate:450` `CLAUDE_SKILL_DIR`.

## Judgement summary

- **Broken at runtime (b):** classes 1 (18), 6 (740), and the executed subset of 2 (≈70 lines
  across `gstack-codex`/`gstack-spec`/`gstack-ship`/`gstack-autoplan`/`gstack-document-release`/
  `gstack-office-hours`), plus E1's `ExitPlanMode` (122) and `subagent_type` (6), classes 3's
  `gstack-claude-code`/`gstack-codex` hits, 4's unguarded `mcp__gbrain__*` calls, and E4.
- **Ambiguous (c):** 3b's hook promises, E2's flag vocabulary, class 3's `~/.claude/plans` probes,
  4's "if unavailable" guards, E3's bare `/name` invocations (host-stacking dependent).
- **Harmless (a):** all five zero-hit safety skills (`careful`, `freeze`, `guard`, `unfreeze`,
  `deslop-shared-libs`), the injected "do NOT read `~/.claude/`" guard text, class 5's historical
  notes, E5's citations, and E6's incidental keyword.
