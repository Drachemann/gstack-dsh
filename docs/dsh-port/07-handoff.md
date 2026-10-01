# 07 — Handoff

> **Superseded in part by [`09-workflow-verification.md`](09-workflow-verification.md).**
> Everything below about the *plugin* (decision tools, Jev binding, pipeline,
> escalation) still holds. The claim of "full skill parity" did not: the skills
> were verified as text and never executed, and the first real workflow
> (`/setup-gbrain`) aborted in the preamble because rendering was mistaken for
> installing. Read 09 first for the corrections, the fixes, and what remains
> unproven.

**Status: G1–G6 complete; all five live paths verified.** The port is built,
installed, and green: the plugin loads in a real DSH boot, 65/65 plugin tests
pass, the port-affected gstack test files pass, and every judgment point has been
exercised against the live endpoint or a real transport.

Live evidence (`node scripts/verify-live.mjs`, paid tier, against OpenCode System
One):

```
PASS  plugin registers its four decision tools
PASS  plugin installs the pre-execution risk gate
PASS  Jev binding reaches OpenCode System One       model=jev-1.13 latency=919ms
PASS  jev_decide returns a calibrated answer        p=0.74 decision=yes confident=true
PASS  gstack_pipeline reports stage state           stage=think (1/7) persistence=missing
PASS  pipeline gate returns a Jev-gated decision    decision=unsure p=0.33 mayAdvance=false
PASS  gstack_route_skill returns a routing choice   choice=gstack-plan-eng-review confidence=0.81
PASS  gstack_escalate dispatches a second opinion   model=jev-1.13-free dispatched=true used=1
8/8 live checks passed
```

Two of those matter more than the rest. The gate returned `unsure` on thin
evidence and **refused to advance** — the port's central claim, working on a live
model rather than a mock. And the escalation check drives the full transport
(`prepareCall` → `stream` → chunk collection → ration accounting) against a stub,
so the one path that had never run outside unit tests now has.

What the probe still does not prove, stated so it is not mistaken for coverage:
the stub's second-opinion text is not a real provider's, and the probe's provider
id is its own rather than the Harness's live route names. Both are manual checks.

**Remaining operational item: `stateDir`.** Pipeline persistence needs it set
explicitly (see G4). No bundle or profile value supplies it today, so a real
session reports `persistence: unavailable` and runs do not survive a session.
Everything else about the port is done.

§3 records what is built and proven, §4 two gstack bugs found and fixed, §5 the
per-item status, §6 the traps worth knowing before touching this.

---

## 1. What was asked

Turn gstack into a DSH plugin: gstack's methodology as native DSH primitives,
`deepseek-v41-flash` as the near-exclusive model, Jev (OpenCode **free**) as a
mandatory decision layer at four judgment points, sparked second-opinion
escalation, project-local `.dsh/` install with version pinning and a receipt,
full skill parity, and a Jev-gated sprint pipeline — after first printing a
host-integration summary, a `repo_setup_scan` report, and a gap analysis, and
getting explicit confirmation. All three were printed and confirmed.

`docs/ADDING_A_HOST.md` was treated as the authoritative porting spec, as
instructed, and its contradictions with the request are flagged in
`03-gap-analysis.md` §1 (D1–D4) and `01-host-integration-summary.md` §6 (C1–C6).

## 2. Deliverables

| # | Deliverable | Status |
|---|---|---|
| 1 | Host-integration summary | ✅ `01-host-integration-summary.md` |
| 2 | `repo_setup_scan` report + reconciliation | ✅ `02-scan-report.md` |
| 3 | Gap analysis (every skill + stage) | ✅ `03-gap-analysis.md` |
| 4 | Plugin source | ✅ built (see §3) |
| 5 | Install receipt, 4 states, version-pinned | ✅ `05-install-receipt.md` |
| 6 | Token-efficiency estimate | ✅ `06-token-efficiency.md` |

## 3. What is built and proven

**gstack host integration** — `hosts/dsh.ts`, registered in `hosts/index.ts`,
`deepseek` model family added to `scripts/models.ts` + `model-overlays/deepseek.md`,
`.gitignore` updated. `host-config-export.ts validate` → **"All 11 configs valid"**.

**Full skill parity** — 57 skills rendered to `.dsh/skills/gstack-*/SKILL.md`
(measured: 50,374 lines, ~797K tokens total). Verified: 57/57 frontmatter names
prefixed `gstack-*`, 57/57 `whenToUse` populated, **zero** leakage of
`AskUserQuestion`, `.claude/skills`, `CLAUDE.md`, or `deepseek-v4-pro`.

**Discovery is proven, not assumed** — the session skill catalog in the GUI
*changed* to the `gstack-*` skills mid-session, i.e. DSH's filesystem watcher
found `.dsh/skills` live with no restart.

**The decision layer** — `.dsh/plugin/lib/{jev,pipeline,escalation,index}.js`:
`jev_decide`, `gstack_pipeline`, `gstack_route_skill`, `gstack_escalate`, and a
`tools/pre-execute` risk gate.

**Verification** — `node --test test/` → **65/65**; `scripts/verify-live.mjs`
→ **8/8** against live OpenCode System One on the paid tier (`jev-1.13`,
~920ms/call). The full probe output is at the top of this document.

Note the gate result: on weak evidence it returned `unsure` (p=0.33) and **refused
to advance**. That is the intended behaviour — an unverified completion claim does
not open the gate.

**Tier history, kept because it drove real code.** Jev originally ran only on the
free tier, and a single `state: "ping"` probe with `retries: 1` was throttled
(HTTP 429 `FreeUsageLimitError`), which meant a sprint stage could not gate at all.
That produced two lasting changes: `testConnection()` now reports
`{ok, kind, status}` so a 429 is machine-readable as `kind: 'rate-limited'` rather
than a broken binding, and `classifyJevFailure()` lets every caller separate a
waitable throttle from a fixable fault. The gate's rate-limit message says *wait*
and its transport-fault message says *fix the binding*; telling someone to repair
a working credential was the original bug. The operator then moved Jev to the paid
tier (`DEFAULT_JEV_MODEL = 'jev-1.13'`; `jev-1.13-free` is still selectable via
`config.model`), which removed the limit from the critical path.

**Deliberately unchanged by that move:** the escalation routes remain free-first,
with a paid route reachable only through an explicit `config.escalation.paidModel`.
Authorising Jev itself to spend does not authorise second opinions to spend.

The risk gate's fail-open path — an unreachable Jev allows the call rather than
bricking the session — stays load-bearing even on the paid tier, since any
transient provider fault still degrades to allowing the call rather than halting
the agent.

**Install** — `gstack-dsh` v1.0.0 as a `link:` bundle in the `web` profile;
`--dump-config` shows the row; a real `dsh web` boot logs zero errors. Global
profile files backed up to `.dsh/backups/`.

## 4. Two bugs found and fixed in gstack itself

Both were discovered by running the real generator, and both are worth landing
upstream — they are gstack bugs, not port artifacts.

1. **`renameFields` silently dropped block-style YAML fields.**
   `scripts/gen-skill-docs.ts` used `:(.+(?:\n(?:\s+.+)*)?)`, which requires at
   least one character after the colon. A YAML block sequence
   (`triggers:` then indented `- item` lines) has nothing after the colon, so the
   match failed and the field vanished without a warning. This is why `whenToUse`
   was empty on the first render. Fixed to
   `:([^\n]*(?:\n[ \t]+[^\n]*)*)`, which handles inline scalars and block values.

2. **Generated frontmatter `name:` did not match the output directory for
   external hosts.** `externalSkillName()` correctly produced `gstack-ship`, but
   `transformFrontmatter()` rebuilt `name:` from the template's bare `ship`. Any
   host keying its catalog on frontmatter (dsh does; it validates and
   de-duplicates on `name`, and its `/name` gesture matches it) would collide
   with same-named skills from other packs. Added an opt-in
   `frontmatter.nameField: 'template' | 'external'`; only `dsh` sets `'external'`,
   so **no other host's output changes**.

## 5. Item status

**G1 — fix gstack's test suite for the 11th host (highest priority).**
`test/host-config.test.ts:37` asserts `ALL_HOST_CONFIGS.length === 10`, and
several others hardcode the roster (`test/gen-skill-docs.test.ts` accept-list and
hostDirs scan, `test/qa-lazy-sections.test.ts`, `test/setup-prune-stale-generated.test.ts`,
`test/setup-sections-linking.test.ts`, `test/gen-skill-docs-idempotency.test.ts`,
`test/setup-windows-rerun-refresh.test.ts`, `test/setup-runtime-lib-command.test.ts`).
**DONE — G1 acceptance.** The full `bun run test` suite was run, and the six
port-attributable failures it surfaced were all fixed: the 10→11 roster count,
the hardcoded 8-host `hostDirs` list, the fixture's `git ls-files` blind spot for
untracked `hosts/dsh.ts`, the `setup --host dsh` arm, the team-init probe loops,
and the depth-2 render path plus per-host `AskUserQuestion` spelling in three
assertions. Residual failures are environmental (Chromium, Xvfb, git identity,
Docker/CSO) and were proven port-immune by stashing `hosts/index.ts` and observing
an identical failure. See `08-resume-after-profile-switch.md` for the full log.

**DONE — G2 — escalation now dispatches.** `gstack_escalate` made a real
second-opinion call through the DSH `llm` service instead of returning an
instruction. New `lib/escalation-dispatch.js` owns the transport
(`llm.prepareCall()` → `prepared.stream()`), `pickEscalationModel()` in
`lib/escalation.js` resolves the exact live model id, and the tool records the
**actual** outcome so a failed dispatch no longer spends the ration. Free-before-
paid is unchanged and paid routes are unreachable without an explicit
`config.escalation.paidModel` opt-in. Note `LlmModelInfo` carries no pricing
field, so "free" is read off the `:free` route naming and never guessed.

**G2 follow-up — the live model list is now read, not injected. DONE.** The
original gap was that `gstack_escalate` needed `config.escalation.discovered`
supplied at mount time or it reported "no eligible model". `discoverModels(llm)`
in `lib/index.js` now walks `ctx.llm.listProviders()` + `await listModels(id)`
and flattens the result, caching it once per session; `config.escalation.discovered`
is an optional pin rather than a required input. Every step is guarded (absent
service, a throwing `listProviders`, one route throwing) and a partial failure
never hides the other routes.

**Still open from G2:** the three escalation routes are not declared in any bundle
patch, so a provider route the profile has not configured simply offers no models
and that tier reports "no eligible model". `cordis.patch.yml` previously claimed an
install step configured them on the `llm-pi-ai` row; that step does not exist, and
the comment now says what is true instead. Declaring the routes — an `llm-pi-ai`
entry carrying the OpenCode and OpenRouter model lists — is what would make every
free tier reachable, and would also expose them in the model selector.

**Also closed:** `apply()` accepts `config.apiKey` and passes it to `JevClient`.
The constructor always supported it; `apply` simply never forwarded it, so the only
working path was an environment variable. Env still wins, so a profile config can
supply a credential without it entering this git-tracked package.

**DONE — G3 — the browser engine is built for Linux.** `bun run build` produced
`browse/dist/browse` as a native ELF x86-64 binary plus `find-browse`,
`server-node.mjs`, `design`, `pdf`, `gstack-global-discover` and the
`.build-complete` stamp. Smoke-tested live: `goto https://example.com` returned
200, `text` extracted content, `screenshot` wrote a PNG. `browse/test/xvfb.test.ts`
(19 tests incl. the full display lifecycle) and `browse/test/watchdog.test.ts` are
green; the browse suite is 42 pass / 1 fail, the single failure being
`clang is required for the POSIX metadata regression` — an optional toolchain gap
in `browse/test/dia-gui-readiness.test.ts`, not a port defect.

**G4 — pipeline state now persists to disk. DONE.** `lib/pipeline-store.js` owns
every filesystem touch: `createPipelineStore({stateDir})` returns a total
`load`/`save`/`clear` that never throws at its caller. Default location is
`{projectRoot}/.dsh/gstack-pipeline.json`, where the project root is found by
walking up from the process working directory to the nearest `.git` — the same
rule DSH's own skill filesystem uses to locate `.dsh/skills`, so the state file
and the rendered skills tree agree on what "the project" is. `config.stateDir`
overrides it; an explicitly blank `stateDir` fails closed rather than silently
falling back to the default.

`apply()` restores a persisted run at boot and fills in a blank objective from
config; the `advance` action mirrors state to disk and reports
`persisted`/`persistError`; `status` reports a `persistence` block naming the
path and how the load went (`ok` | `missing` | `invalid` | `unreadable` |
`unavailable`). A load that is neither `ok` nor `missing` starts a fresh run and
logs why, so "I could not read your last run" can never pass for "you have no
last run". Writes are atomic (temp file + rename) and a corrupt file is reported
and left in place, never silently replaced.

Evidence: `.dsh/plugin/test/pipeline-store.test.js` (14 tests) covers the git-root
walk, the blank-override fail-closed case, round-trip through disk, missing vs
invalid vs unreadable, atomic save with no temp-file residue, `clear`
idempotence, the totally-unavailable store, boot restore from a prior run,
advance-writing-through, corrupt-state fallback, and objective precedence.
Full plugin suite: **65 tests, 65 pass, 0 fail** (`node --test test/`).

**G5 — closed by operator decision.** The `deepseek-v4-pro` references at
`~/.dsh/profiles/web/cordis.patch.yml:441,447` and
`dsh-tokenslash/lib/shared/constants.js:66` were reviewed and the operator chose
to **leave the model available**; it is no longer a blocker. Context worth keeping:
`dsh-tokenslash` is a private local package whose own manifest declares
`dsh.bundle.patch: cordis.patch.yml`, so it is the single owning source of both the
profile patch file and the pricing table — a one-source fix if that ever reverses.
Source lives at `~/src/dsh-tokenslash`.

**G6 — README section and `symlinks` assertions. DONE.** `README.md` now lists
DeepSeek Harness as the 11th agent (the count in prose went 10 → 11) and carries a
`--host dsh` row plus a paragraph. It documents the real behaviour rather than an
install that does not exist: `./setup --host dsh` prints instructions, and
`bun run gen:skill-docs --host dsh` is the step that renders
`.dsh/skills/gstack-*/SKILL.md`, which the Harness discovers and watches live. The
paragraph also names the capability **loss** (no per-skill tool allowlist, so
`allowed-tools` is dropped) and the suppressed cross-harness outside-review
resolvers, matching `hosts/dsh.ts:28-30` and `:94-100`.

`test/host-config.test.ts` gained a `dsh symlinks` case pinning the exact set
`host-config-export.ts symlinks dsh` prints — `bin`, `browse/dist`, `browse/bin`,
`gstack-upgrade`, `ETHOS.md`, `review/checklist.md`, `review/TODOS-format.md` —
derived from `runtimeRoot` at `hosts/dsh.ts:106-111`. Before this, opencode was
the only host whose `symlinks` output had a detailed assertion.

Evidence: `test/host-config.test.ts` **77 pass / 0 fail**; the other three
port-affected files (`gen-skill-docs`, `plan-review-cases`,
`devex-finding-fixture`) unchanged and green.

## 6. Traps worth knowing before touching this

- **`file:` copies, `link:` symlinks.** The install uses `link:` so `.dsh/plugin/`
  stays the source of truth. If a source edit appears to have no effect, check
  `~/.dsh/profiles/web/node_modules/gstack-dsh` resolves to the symlink. This bit
  during development and cost a debugging cycle.
- **`bun` is not on PATH.** gstack's generator is Bun-targeted (uses
  `import.meta.dir`, `Bun.*`). Run it as
  `mise exec bun@latest -- bun run scripts/gen-skill-docs.ts --host dsh`.
  Do **not** try to run the generator under plain Node — extensionless relative
  imports fail, and patching that in is a rabbit hole.
- **System One is not OpenAI-compatible.** `POST <base>/v1/systemone` with
  `{model, state, questions}`; `state` is the *evidence text*, not a status enum.
  Question types are `noul` and `choice` (with a `criteria` **map**). Sending
  `bool`, an `options` array, or a `messages` array all return
  `HTTP 400 api_usage_error`. All of this was established empirically.
- **DSH tool schemas reject `required: false`.** Omit the key for optional
  parameters. This only surfaced on a real boot, not in unit tests.
- **`.dsh/plugin/node_modules/@deepseek-ai/dsh-tools`** is a test-only stub so the
  unit suite runs without DSH. Keep `.dsh/plugin/node_modules/` gitignored; the
  real package comes from the profile.

## 7. Profile/agent-profile note

The operator reports this task belonged under the **"Capability Evolution"**
profile. This session ran under the `web` profile. The work products are
profile-agnostic — nothing here depends on which agent preset was active except
the *profile patch* it wrote, which targeted `web` because that is the profile
that is actually installed and bootable on this machine
(`~/.dsh/profiles/` = `acp`, `headless`, `web`; there is no `capability-evolution`
profile directory). **If Capability Evolution is a preset rather than a profile,
the install target may need to move** — verify before assuming the current
install location is still correct.
