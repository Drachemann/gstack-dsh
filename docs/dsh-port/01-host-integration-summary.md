# 01 — Host-Integration Summary

Source of truth: `docs/ADDING_A_HOST.md` (gstack v1.91.9.0, fork `Drachemann/gstack-dsh` @ `96764e80`),
cross-checked line-by-line against the code it describes. Where the doc and the code disagree,
the code wins and the disagreement is recorded in §6 (Contradictions).

This summary is written before any design work, as required.

---

## 1. What gstack's host contract actually is

`ADDING_A_HOST.md:3-7` states the contract plainly: **a host is a typed TypeScript config object**,
not a code path. Each supported agent gets one file under `hosts/` that calls `defineHost()` and
default-exports a `HostConfig`; a registry at `hosts/index.ts` imports every config into
`ALL_HOST_CONFIGS` and derives the `Host` union from it (`hosts/index.ts:21,29,32,68`).

The doc calls this "declarative host config system" and claims adding a host means "creating one
file and re-exporting it. Zero code changes to the generator, setup, or tooling"
(`ADDING_A_HOST.md:5-7`). What the config *tells the system* is enumerated at
`ADDING_A_HOST.md:27-34`:

- where to put generated skills (paths),
- how to transform frontmatter (allowlist/denylist fields),
- what Claude-specific references to rewrite (paths, tool names),
- what binary to detect for auto-install,
- what resolver sections to suppress,
- what assets to symlink at install time.

**The "zero code changes" claim is true for the generator and false for setup.** This is the single
most important finding for the DSH port, and §6 records it as contradiction C1.

## 2. The factory and its defaults

`defineHost()` (`hosts/define-host.ts:75-159`) takes required `name` + `displayName` plus
`Partial<Omit<HostConfig,'name'|'displayName'>>`, and supplies a common external-host default for
everything else (`ADDING_A_HOST.md:43-46` — "A fully-default host is two fields", naming
`hosts/slate.ts` and `hosts/cursor.ts`).

Defaults that matter for DSH (`hosts/define-host.ts:83-119`):

| Field | Default | Why it matters for DSH |
|---|---|---|
| `globalRoot` / `localSkillRoot` | `.${name}/skills/gstack` | **This is the whole game.** DSH discovers project skills at `{projectRoot}/.dsh/skills` — the default derivation already lands on the right tree. |
| `hostSubdir` | `.${name}` | Must be `.dsh`; DSH's discovery root is literally `.dsh/skills`. |
| `usesEnvVars` | `true` | Emits an env-var preamble bootstrap (`$GSTACK_ROOT/$GSTACK_BIN/...`). DSH is not guaranteed to set these, so the port must decide deliberately. |
| `frontmatter` | allowlist keeping `name` + `description`, no limit | The hook where gstack's schema is translated into DSH's. |
| `generation` | `generateMetadata:false, skipSkills:[]` | No sidecar metadata; DSH needs none. |
| `suppressedResolvers` | `[...GBRAIN_RESOLVERS]` | Default suppression is *only* the GBrain pair. `CROSS_MODEL_RESOLVERS` must be added explicitly. |
| `runtimeRoot` | `bin`, `browse/dist`, `browse/bin`, `gstack-upgrade`, `ETHOS.md` + 2 review files | Assets that runtime shells out to. |
| `install.linkingStrategy` | `symlink-generated` | Validated metadata only — see C2. |

Two input-only escape hatches (`ADDING_A_HOST.md:77-86`): `extraPathRewrites` **appends** to the
derived rewrite trio; `pathRewrites` **replaces** it. They are mutually exclusive and the factory
throws if both are supplied (`hosts/define-host.ts:121-126`). Shared constants for composition:
`CROSS_MODEL_RESOLVERS`, `GBRAIN_RESOLVERS`, `EXEC_STYLE_TOOL_REWRITES`
(`ADDING_A_HOST.md:88-93`).

## 3. The five transformation surfaces

These are the mechanisms the port must use rather than inventing something new.

**(a) Path rewrites.** Derived trio when not replaced (`hosts/define-host.ts:128-133`):
`~/.claude/skills/gstack` → `~/{globalRoot}`; `.claude/skills/gstack` → `{localSkillRoot}`;
`.claude/skills` → `{hostSubdir}/skills`. Applied with literal `replaceAll`, in array order
(`scripts/gen-skill-docs.ts:570-581`), to both SKILL.md (`:728`) and section files (`:852-853`).
Non-mechanical hosts (codex, factory) replace the trio and rewrite the global path to
`$GSTACK_ROOT` (`ADDING_A_HOST.md:82-84`).

**(b) Frontmatter transform.** `transformFrontmatter()` (`scripts/gen-skill-docs.ts:432-524`)
supports `mode: allowlist|denylist`, `keepFields`, `stripFields`, `descriptionLimit` +
`descriptionLimitBehavior: error|truncate|warn`, `extraFields`, `conditionalFields`
(`{if, add}`), and `renameFields` (`ADDING_A_HOST.md:158-166`). This is the only sanctioned way
to change skill frontmatter, and therefore **the** integration point for DSH's
`whenToUse` / `user-invocable` / `disable-model-invocation` keys.

**(c) Tool rewrites.** Literal string substitution of Claude tool names, applied after path
rewrites (`scripts/gen-skill-docs.ts:575-579`). Hermes is the reference case — it maps
"use the Bash tool" → "use the terminal tool", "the Write tool" → "the patch tool", etc.
(`hosts/hermes.ts:10-20`).

**(d) Resolver suppression.** A suppressed token resolves to `''` *before* the
unknown-placeholder throw (`scripts/gen-skill-docs.ts:619-627`), so suppression is how a host
opts out of a preamble section it cannot run. `suppressedResolvers` entries are validated against
a known-resolver list (`scripts/host-config.ts:159-165`).

**(e) Model overlay.** `HostConfig.defaultModel` (`scripts/models.ts:18-30`,
`ALL_MODEL_NAMES`) selects `model-overlays/{family}.md`, injected into the preamble via
`generateModelOverlay()` (`scripts/resolvers/model-overlay.ts:23-69`). **Host ≠ model**
(`scripts/models.ts:6-13`): the model axis is independent, and `defaultModel` is the generation
default when no `--model` is passed (`scripts/gen-skill-docs.ts:676`).

## 4. Validation and registration obligations

`validateHostConfig()` (`scripts/host-config.ts:116-168`) enforces: name matches
`/^[a-z][a-z0-9-]*$/`; non-empty `displayName`; `cliCommand`/aliases match `/^[a-z][a-z0-9_-]*$/`;
`defaultModel` is a known model family; paths match `/^[a-zA-Z0-9_.\/${}~-]+$/`; `frontmatter.mode`
and `install.linkingStrategy` are the two legal literals each. `validateAllConfigs()`
(`:170-201`) adds cross-config uniqueness on `name`, `hostSubdir`, and `globalRoot`
(`localSkillRoot` is deliberately not uniqueness-checked).

Registration (`ADDING_A_HOST.md:99-113`): import the config, add it to `ALL_HOST_CONFIGS`,
re-export it. `.gitignore` must then exclude the host's generated output dir
(`ADDING_A_HOST.md:115-117`).

## 5. Verification surface the doc promises

`ADDING_A_HOST.md:119-145` says generation is `bun run gen:skill-docs --host <name>`, output
verification is `ls .<name>/skills/gstack-*/SKILL.md`, health is `bun run skill:check`, and the
parameterized smoke tests "automatically pick up the new host. Zero test code to write" —
verifying output exists, no path leakage, valid frontmatter, freshness, and each host's
outside-review exclusions.

That promise is **mostly** true but not entirely: several tests hardcode the host roster and will
fail on registration. The exhaustive list is in §6/C3.

## 6. Contradictions and gaps found against the code

**C1 — "Zero code changes to setup" is false for any installable host.**
`ADDING_A_HOST.md:7` claims zero changes to "the generator, setup, or tooling".
`scripts/host-config-export.ts:5-7` states the opposite in the code itself: setup is
"NOT yet wired into ./setup — setup still hand-rolls its host lists (a known drift source)".
`setup` contains no import of `hosts/**` or `host-config` at all; `--host` is validated by a
hand-written `case` (`setup:108-155`) with a hardcoded accept-list
`claude|codex|kiro|factory|opencode|cursor|auto` (`setup:109`), hand-rolled `command -v` probes
(`setup:695-708`), hand-coded per-host root variables (`setup:172-180`), and per-host
`create_*_runtime_root` / `link_*_skill_dirs` functions (`setup:1950-2268`, `:2170-2210`).
There is even a guard that errors if a host reaches the accept-list with no install arm
(`setup:723-729`). **Consequence for this port:** a *render-only* host needs zero setup edits
(the doc's promise holds); a *full-install* host needs roughly the eight setup touchpoints.
The DSH port deliberately chooses the render-only path (see §7).

**C2 — `install.linkingStrategy` and `runtimeRoot` are declarative metadata, not executed switches.**
`ADDING_A_HOST.md:74,164-165` presents them as behavior. Repo-wide, `linkingStrategy` appears only
in `hosts/*.ts`, `scripts/host-config.ts:91,151-152`, tests, and docs — setup never reads it.
`runtimeRoot` is consumed only by `scripts/host-config-export.ts:93-111`; setup duplicates the
asset lists by hand. Codex's own config comment concedes this: the sidecar behavior "lives in
setup's create_agents_sidecar, not here" (`hosts/codex.ts:22-26`). **Consequence:**
`runtimeRoot` is documentation-grade; declaring it does not install anything.

**C3 — The "zero test code to write" promise is incomplete.**
At least these hardcode the roster and must be updated on registration:
`test/host-config.test.ts:37` (asserts `ALL_HOST_CONFIGS.length === 10`),
`test/gen-skill-docs.test.ts:3499-3504` (accept-list string), `:4440` (hostDirs scan list),
`test/qa-lazy-sections.test.ts:539`, `test/setup-prune-stale-generated.test.ts:93-105`,
`test/setup-sections-linking.test.ts:4`, `test/gen-skill-docs-idempotency.test.ts:46`,
`test/setup-windows-rerun-refresh.test.ts:50-70`, `test/setup-runtime-lib-command.test.ts:154-159`.
Tests that genuinely auto-cover the new host (they iterate `ALL_HOST_CONFIGS`/`ALL_HOST_NAMES`):
`scripts/gen-skill-docs.ts:896`, `scripts/resolvers/types.ts:47`, `scripts/skill-check.ts:10`,
`lib/worktree.ts:128`, `test/gen-skill-docs-checks.test.ts`.

**C4 — No model family exists for DeepSeek/Flash, so a DeepSeek `defaultModel` is unrepresentable.**
`ADDING_A_HOST.md:160` says `defaultModel` is "validated against `ALL_MODEL_NAMES` in
`scripts/models.ts`". That list is `claude, opus-4-7, fable-5, opus-4-8, sonnet-5, gpt, gpt-5.4,
gpt-5.6-sol, gpt-6-astra, gemini, o-series` (`scripts/models.ts:18-30`) — no DeepSeek entry
anywhere in source. A `defaultModel: 'deepseek'` fails validation
(`scripts/host-config.ts:135-138`) and `--model deepseek` throws
(`scripts/gen-skill-docs.ts:108-112`). **Consequence:** either the DSH host inherits the
`claude` overlay (inexact — the overlay is Claude-behavioral advice), or the port adds a
`deepseek` family to `scripts/models.ts` plus `model-overlays/deepseek.md`. The port does the
latter, because C4 resolution is cheap and the alternative ships a knowingly wrong model overlay.

**C5 — `bin/gstack-uninstall` has no arm for every host it installs.**
It handles Claude, `.agents`/Codex, Factory, Kiro, and Cursor, but contains no `opencode`
handling at all. `bin/gstack-relink` likewise has no external-host arm. This is a pre-existing
gstack gap, not a DSH-specific one; recorded because the port must not assume uninstall
symmetry exists.

**C6 — The canonical sprint order is not encoded anywhere machine-readable.**
`ADDING_A_HOST.md` and the skill templates contain no state machine. The order the task
statement gives (`/office-hours → /plan-ceo-review → /plan-eng-review → /review → /ship → /qa
→ /retro`) exists only as prose in `README.md` and as ad-hoc `benefits-from:` frontmatter hints
(e.g. `autoplan/SKILL.md.tmpl:17`). **Consequence:** "the sprint pipeline must be a first-class
workflow with Jev-gated stage transitions" is *new construction*, not a port of existing state.

## 7. How a `dsh` host lands against this contract

Translated directly from the above, the DSH host is a **render-only host**:

- `name: 'dsh'`, `hostSubdir: '.dsh'`, `localSkillRoot: '.dsh/skills/gstack'`,
  `globalRoot` left at the derived `.dsh/skills/gstack` default — which is exactly where DSH's
  own filesystem skill provider looks (`@deepseek-ai/dsh-skill-filesystem`, `roots()`:
  `join(projectRoot, ".dsh/skills")`, source `project-dsh`, `includeDefaultRoots`).
- `frontmatter`: allowlist + `renameFields` to DSH's `whenToUse` + `extraFields`/`conditionalFields`
  for DSH's `user-invocable` grammar; drop gstack keys DSH does not read.
- `pathRewrites`: rewrite the Claude paths onto DSH's project tree and map `CLAUDE.md` → `AGENTS.md`.
- `toolRewrites`: map gstack's `AskUserQuestion` / Bash / Read / Write / Edit phrasings onto DSH's
  real tools (`ask_user_question`, `bash`, `read`, `write`, `edit`).
- `suppressedResolvers`: `[...CROSS_MODEL_RESOLVERS]` — DSH cannot run gstack's Claude/Codex
  shell-outs; the port replaces that capability with its own escalation layer.
- `defaultModel`: a new `deepseek` family + `model-overlays/deepseek.md` (resolves C4).
- No `setup` edits (C1 avoided), no sidecar, no metadata file, no aliases.
- No installer is needed at all: DSH discovers `.dsh/skills` natively at session open, which is
  precisely the "installs into the project's `.dsh/` profile and auto-loads" requirement.
