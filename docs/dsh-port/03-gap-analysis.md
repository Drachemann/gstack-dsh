# 03 — Gap Analysis

For every gstack skill and every workflow stage: does it map **cleanly** to DSH primitives, need
**adaptation**, or need **new construction**?

Grading key:

- **CLEAN** — works after the mechanical `--host dsh` transform (paths, frontmatter, tool names).
  No per-skill engineering.
- **ADAPT** — the skill's *logic* survives, but a specific mechanism inside it does not exist on
  DSH and must be re-pointed at a DSH primitive.
- **NEW** — the capability has no gstack equivalent; it must be built.

Inventory basis: **57 skill directories**, each with a `SKILL.md.tmpl` (57 templates; 56 rendered
`SKILL.md` in-tree because Claude renders some differently). The root router is `./SKILL.md`
(`name: gstack`, `preamble-tier: 1`).

---

## 1. Requirement contradictions (flagged, per instructions)

Four contradictions were found between the task statement and the authoritative spec/state.
Per instruction, `ADDING_A_HOST.md` (and the code it describes) wins.

### D1 — "Install into the project's `.dsh/` profile so it auto-loads" assumes a project-local *profile*; DSH has no such concept.

`ADDING_A_HOST.md` describes host install as writing generated skills to `globalRoot` /
`localSkillRoot` and (for full hosts) symlinking a runtime root. DSH's own profile system lives at
`$DSH_HOME/profiles/<name>` (`/home/matt/.dsh/profiles/web`) and is selected by
`dsh --profile <name>`. There is **no** DSH mechanism that loads a project directory as a profile.

**Resolution (follows DSH's actual contract, satisfies the requirement's intent):** DSH's
filesystem skill provider natively scans `{projectRoot}/.dsh/skills` as the highest-ranked
project root, cwd-scoped, and watches it live. Writing gstack's generated skills there means they
auto-load on session open with **no** profile edit, **no** global install, **no** GUI step —
exactly the stated intent. The port therefore uses `.dsh/skills/` as the auto-load surface and
does **not** pretend `.dsh/` is a profile. This is a strictly better fit than the requested
mechanism.

### D2 — "Version-pinned and receipted through your managed-source workflow" vs. render-only host.

gstack's own contract has no receipt concept; the closest analogues are the generated banner
(`scripts/gen-skill-docs.ts:562`), the `.gstack-owned` marker, and `generation.generateMetadata`
(Codex's `agents/openai.yaml`, the only host that emits metadata). DSH's `dsh.plugin.json`
descriptor carries `id`/`version`/`main`/`contributes`.

**Resolution:** the port creates a real versioned plugin manifest (`dsh.plugin.json` + a DSH
profile entry) *in addition to* the gstack render, and records the install receipt as an explicit
state document. This satisfies both contracts without violating either.

### D3 — `defaultModel: deepseek-*` is not representable in gstack's model axis.

`ALL_MODEL_NAMES` (`scripts/models.ts:18-30`) has no DeepSeek family; `validateHostConfig` rejects
an unknown `defaultModel`. So "route to `deepseek-v41-flash`" cannot be expressed in the *host
config* today.

**Resolution:** the port adds a `deepseek` family to `scripts/models.ts` + `model-overlays/deepseek.md`
(so the host config is legal and the overlay is accurate), and expresses the *actual* routing
where DSH actually routes models — `agent-default-model` and `llm-pi-ai` (see §4).

### D4 — `deepseek-v4-pro` currently exists in the live environment, which the requirement forbids.

The requirement says `deepseek-v4-pro` "is outdated and must not appear anywhere in the
configuration, routing tables, or defaults." It is presently present in the *global* profile:
`profile/cordis.patch.yml:441` and `:447` (a model list) and in
`dsh-tokenslash/lib/shared/constants.js:66` (a pricing table).

**Resolution:** the port's own artifacts (host config, plugin, model routing, skill text) will
contain **zero** references to `deepseek-v4-pro` — verifiable by grep. Removing it from the
pre-existing global profile is a separate change to a shared, user-owned file; it is **flagged
for explicit approval** rather than done silently, because it is outside the project workspace and
was not part of the stated build.

---

## 2. Skill-by-skill mapping

### 2.1 Skills named in the task statement

| gstack skill | DSH mapping | Grade | The specific gap and its resolution |
|---|---|---|---|
| `/plan-ceo-review` | DSH skill `gstack-plan-ceo-review` | **ADAPT** | Role prompt, 10-star framing, and completion criteria are pure prose → portable. Gaps: frontmatter (`preamble-tier`, `allowed-tools`, `triggers` are not DSH keys); `AskUserQuestion` → DSH `ask_user_question`. Its "outside voice" step is a Claude/Codex shell-out → must be re-pointed at the Jev/second-opinion layer. |
| `/plan-eng-review` | `gstack-plan-eng-review` | **ADAPT** | Same mechanical gaps. This is the skill the task identifies as needing deeper reasoning — so it is the one workflow stage with a *legitimate* non-Flash escalation, which must resolve its model from DSH's live list rather than a hardcoded id (D3). |
| `/plan-design-review` | `gstack-plan-design-review` | **ADAPT** | Report-only, never touches code — that property is prose and survives. Gaps: the 80-item checklist is a generated reference file (`review/design-checklist.md` from `lib/design-catalog.ts`) and must be rendered/linked for DSH, not assumed to sit at the Claude path. Letter-grade + AI-slop detection are prose → portable. |
| `/review` | `gstack-review` | **ADAPT** | The core "find bugs CI misses" logic is portable. The real gap is its **multi-model review army** (`REVIEW_ARMY`) and adversarial outside review (`ADVERSARIAL_STEP`) resolvers, which shell out to other harnesses. On DSH these are suppressed and replaced by the Jev second-opinion escalation policy. |
| `/ship` | `gstack-ship` | **ADAPT** | Heavy `Bash`/`git`/`gh` usage; DSH has a `bash` tool, so it runs. Gaps: it is a *sensitive* skill (it pushes and opens PRs) and needs DSH's `disable-model-invocation` decision, plus the `~/.claude/...` preamble bootstrap must be rewritten to the DSH install. Repo-specific commands are read from `CLAUDE.md` → must read `AGENTS.md` on DSH. |
| `/browse` | `gstack-browse` | **ADAPT** | The skill is a wrapper around gstack's own browser engine (`browse/dist`, an Aside-first fallback engine per `CLAUDE.md`). Both engines are gstack-owned binaries, not DSH primitives — they can be invoked through `bash` if built, but there is **no DSH-native browser tool**. This is the single largest capability gap: it needs the browse binary built for Linux, or the skill degrades. |
| `/qa` | `gstack-qa` | **ADAPT** | Same browser dependency as `/browse`. Its Before/After health scores and three tiers (Quick/Standard/Exhaustive) are prose → portable. Atomic-commit fixing uses git via `bash` → fine. |
| `/qa-only` | `gstack-qa-only` | **ADAPT** | Report-only variant; identical browser dependency. Notably `usesLazySections` special-cases `qa`/`qa-only` (`scripts/resolvers/sections.ts:28-30`) — a class of two that lazy-loads sections; the DSH render must handle section files for these two. |
| `/qa-design-review` | — | **NEW (naming)** | **This skill does not exist as a directory in this fork.** The `/plan-design-review` and `/design-review` skills exist; there is no `qa-design-review`. The task's description ("same design audit as `/plan-design-review`, then fixes with `style(design):` commits") maps onto `design-review` + `qa` behavior, so the port must either (a) compose it as a new DSH-side skill, or (b) treat it as the `design-review` skill renamed. **Flagged as a real fork/statement mismatch** — see §3.3. |
| `/setup-browser-cookies` | `gstack-setup-browser-cookies` | **ADAPT** | Imports cookies from a real Chromium into gstack's headless session. Depends on the gstack browser engine + a real local browser profile. On DSH, the import path works only if the engine runs; otherwise it is inert. |
| `/retro` | `gstack-retro` | **CLEAN → ADAPT** | Reads git history and writes a retrospective; no Claude-specific mechanism. Light adaptation (frontmatter + tool names). |
| `/document-release` | `gstack-document-release` | **CLEAN → ADAPT** | README/ARCHITECTURE/CONTRIBUTING updates via fs tools. Portable. Its redaction guard calls gstack's own `bin/gstack-redact` — which is a gstack binary, invoked via `bash`, so it survives. |

### 2.2 State-management skills explicitly named in the statement

| gstack skill | DSH mapping | Grade | Notes |
|---|---|---|---|
| `/context-save` | `gstack-context-save` | **ADAPT** | Writes to `~/.gstack/projects/<slug>/`. That path is gstack's own state convention, not a DSH one. **This is the "state/artifact convention" the port must decide:** keep gstack's convention (so gstack tooling keeps working) or move to a DSH state dir. The port keeps gstack's convention, because DSH also has `.dsh/` state and duplicating would fork the state model. |
| `/context-restore` | `gstack-context-restore` | **ADAPT** | Reads the same store. On DSH it can additionally read `.dsh/` session artifacts. |
| `/learn` | `gstack-learn` | **ADAPT** | `learningsMode: 'basic'` is a **host config field** (`hosts/define-host.ts:117`), so the DSH host must choose full vs basic deliberately. |

### 2.3 The remaining 43 skills (full parity set)

These all follow the same mechanical transform. They are listed with the reason they need
adaptation, grouped by the DSH primitive that has to absorb them.

**Group A — pure prose + fs/shell (grade CLEAN, mechanical transform only).** 21 skills:
`autoplan`, `benchmark`, `benchmark-models`, `canary`, `design-consultation`, `design-html`,
`design-shotgun`, `devex-review`, `diagram`, `document-generate`, `health`, `investigate`,
`landing-report`, `make-pdf`, `pair-agent`, `plan-devex-review`, `plan-tune`, `scrape`,
`spec`, `test-audit`, `gstack-upgrade`.
Caveat: several invoke gstack-owned binaries (`bin/gstack-render.ts`, make-pdf engine, design
engine) via `bash`; they work only where those binaries are built for Linux.

**Group B — router/orchestration (grade ADAPT).** `gstack` (root router), `autoplan`
(auto-review pipeline), `skillify`, `open-gstack-browser`, `setup-deploy`, `land-and-deploy`,
`careful`, `guard`, `freeze`, `unfreeze`.
The safety skills (`careful`, `guard`, `freeze`, `unfreeze`) have **no `preamble-tier`** and are
session-state mutators. DSH has its own sandbox/approval policy
(`sandbox-local`, `sandbox-policy`, `user-approval` with `read-only|workspace-write|danger-full-access`
× `ask|never`). **These skills partially duplicate a DSH-native capability** — the honest mapping is
that DSH's approval policy is authoritative and the gstack skills become documentation/thin
wrappers, not a competing gate.

**Group C — host-bridge skills (grade ADAPT or DROP).** `codex`, `claude-code`,
`gstack-upgrade`, `sync-gbrain`, `setup-gbrain`, `cso`, `deslop-shared-libs`, `ios-*` (7 skills).
`codex` and `claude-code` wrap *other harnesses*; on DSH they are meaningless or actively
confusing unless deliberately re-aimed. `ios-*` require Xcode/macOS and are inert on this host.
`gbrain` skills require the gbrain daemon, which `define-host.ts:71` already suppresses by default
via `GBRAIN_RESOLVERS`. Recommendation: render them for parity but mark them host-gated, and
**suppress the cross-harness ones** (`codex`, `claude-code`) on the DSH host, mirroring how
`hosts/codex.ts:36` skips its own wrapper (`skipSkills: ['codex']`).

**Group D — browser-dependent (grade ADAPT).** `browse`, `qa`, `qa-only`, `design-review`,
`canary`, `benchmark`, `scrape`, `pair-agent`, `open-gstack-browser`, `setup-browser-cookies`,
`ios-qa`, `ios-design-review`.
All depend on the gstack browser engine or Aside. On Linux with no built engine these degrade.
This is the **largest single risk** to "full skill parity" and is called out in §4.

---

## 3. Workflow-stage mapping

### 3.1 The sprint loop

The task defines the loop as **Think → Plan → Build → Review → Test → Ship → Reflect**, with
canonical invocation `/office-hours → /plan-ceo-review → /plan-eng-review → /review → /ship →
/qa → /retro`.

| Stage | gstack skills | DSH mapping | Grade |
|---|---|---|---|
| **Think** | `office-hours` | skill + Jev routing decision | ADAPT |
| **Plan** | `plan-ceo-review`, `plan-eng-review`, `plan-design-review`, `plan-devex-review`, `design-consultation` | skills + Jev-gated transition to Build | ADAPT |
| **Build** | `spec`, `investigate`, `diagram`, `design-html`, `document-generate` | skills + Jev tool-risk gate | ADAPT |
| **Review** | `review`, `design-review`, `cso`, `devex-review`, `plan-tune` | skills + **second-opinion escalation** replaces the review army | **NEW** (escalation layer) |
| **Test** | `qa`, `qa-only`, `ios-qa`, `benchmark`, `test-audit` | skills; browser engine dependency | ADAPT |
| **Ship** | `ship`, `land-and-deploy`, `document-release`, `setup-deploy`, `canary` | skills; sensitive-skill invocation policy | ADAPT |
| **Reflect** | `retro`, `learn`, `context-save`, `context-restore`, `health` | skills + Jev context-pruning | ADAPT |

### 3.2 The four Jev judgment points the task requires

None of these exist in gstack. All four are **NEW construction**, and they map onto real DSH
extension points rather than invented ones:

| Required judgment point | gstack equivalent | DSH extension point | Grade |
|---|---|---|---|
| **Skill routing** ("which skill for this state?") | none — the user/types pick the slash command; the root router is prose | Jev `triage` call + a `jev_decide` tool; a router skill | **NEW** |
| **Tool-call risk classification** (risk / irreversibility / task-fit / injection-suspicion) | partial — `careful`/`guard` are static destructive-command regex guards | DSH tool-pre-execution assessment + `user-approval` policy | **NEW** (replaces a static guard with a calibrated classifier) |
| **Context pruning between stages** | `compaction-basic` is FIFO/summarizing; gstack has `context-save` | DSH `compaction-*` rows + Jev relevance scoring | **NEW** |
| **Output verification** ("does this satisfy the skill's completion criteria?") | none — skills self-report completion in prose | post-skill Jev calibrated probability gate | **NEW** |

Two of these directly replace *lossy* existing behavior (FIFO compaction, static regex guards),
which is where the token argument in deliverable 6 comes from.

### 3.3 Naming and invocation gaps (ADAPT, mechanical but user-visible)

- DSH user invocation is a literal `/name` token naming a **user-invocable** skill
  (`@deepseek-ai/dsh-tool-skill`: "A `/name` token in direct user input that names a
  user-invocable skill injects that skill's instructions"). Model-side discovery uses a catalog
  of `name` + capped `description` (`catalogDescriptionMaxLength`, default 500).
- gstack names external-host skills `gstack-<dir>` (`scripts/external-skill-names.ts:1-6`), and
  the root router stays `gstack`. So on DSH the commands read `/gstack-ship`, `/gstack-review`,
  `/gstack-qa` — **not** `/ship`, `/review`, `/qa`. The task says "every slash command in gstack
  must exist as a DSH skill"; they will all exist, under the `gstack-` prefix. Flagged because it
  is a literal deviation from the `/ship` spelling in the task.
- DSH's `isSkillName()` requires kebab-case; all gstack names except the root already are, and the
  root's `gstack` is valid.
- gstack's `triggers:` frontmatter has **no DSH equivalent**; DSH's nearest key is `whenToUse`.
  Without the rename, every gstack trigger list is silently dropped (`transformFrontmatter`
  allowlist keeps only `name` + `description` by default).
- DSH has **no `allowed-tools` concept** — no per-skill tool allowlist exists. gstack's
  `allowed-tools` blocks become advisory prose in the body. This is a real capability *loss* in the
  port and should be stated plainly rather than papered over.

### 3.4 `/qa-design-review` — the one skill in the statement that has no directory

The task lists `/qa-design-review` ("Designer + frontend engineer… then fixes what it finds with
atomic `style(design):` commits"). The fork has **no** `qa-design-review/` directory. It has
`plan-design-review` (report-only review) and `design-review` ("Designer's eye QA: finds visual
inconsistency…", `preamble-tier: 4`).

Per instruction, `ADDING_A_HOST.md`/the fork wins. **Resolution:** treat `/qa-design-review` as
satisfied by the `design-review` skill (it already is the QA-flavored design audit and already
writes fixes), and record the naming discrepancy rather than fabricating a skill with no template.
If genuine parity with the task's name is wanted, the port can additionally register a thin DSH
alias skill that routes to `gstack-design-review`.

---

## 4. Capability gaps that are genuinely new construction

| # | Capability | Why it cannot be ported | DSH primitive it must use |
|---|---|---|---|
| N1 | **Jev decision layer** (`jev_decide` tool + 4 judgment points) | No gstack equivalent exists | Jev `POST /v1/systemone` (verified working: OpenCode free `jev-1.13-free`), exposed as a DSH tool |
| N2 | **Second-opinion escalation policy** (Jev-confidence-gated, per-session budget cap) | gstack's equivalent is the review army, which shells out to other harnesses and is suppressed on non-Claude hosts | `llm-pi-ai` provider routes (OpenCode/OpenRouter free first), surfaced in the DSH model selector |
| N3 | **Sprint pipeline as first-class state with Jev-gated transitions** | The order exists only as prose; no state machine anywhere (contradiction C6) | A workflow/state artifact under `.dsh/` + the `jev_decide` gate |
| N4 | **Sensitive-skill invocation policy** | gstack relies on Claude's `allowed-tools`; DSH uses `disable-model-invocation` / `user-invocable` | Host `frontmatter.conditionalFields` + DSH invocation grammar |
| N5 | **Browser/QA capability on Linux** | gstack's engines are its own macOS-oriented binaries | Keep the gstack browser skill, but the engine must be built for Linux; otherwise `/browse`, `/qa`, `/qa-only`, `design-review` degrade to report-only prose |
| N6 | **DSH-native model family + overlay** | `deepseek` is not in `ALL_MODEL_NAMES` (C4/D3) | `scripts/models.ts` + `model-overlays/deepseek.md` |

---

## 5. Grade roll-up

| Grade | Count | Where |
|---|---|---|
| **CLEAN** (mechanical transform only) | 21 | Group A §2.3 |
| **ADAPT** | 34 | 12 named skills + 4 state skills + Group B/C/D |
| **NEW** | 6 | N1–N6, incl. all four Jev judgment points and the pipeline state machine |
| Not present in fork | 1 | `/qa-design-review` (§3.4) |

**Bottom line:** ~37% of skills port mechanically, ~60% need targeted adaptation, and the
*genuinely new* work is concentrated in exactly the things the task asks for beyond gstack's
existing behavior — Jev, escalation, pipeline state, and the model family. No skill's role prompt,
completion criteria, or output format needs to be rewritten; they need the `--host dsh` transform
plus re-pointing of the mechanisms that shell out to other harnesses.
