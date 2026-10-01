# 08 — Resume after profile switch

**Why this document exists.** The G1–G6 work was resumed under the "Capability
Evolution" agent profile, which cannot execute any of it. Nothing was changed.
This file records the exact blocker, the exact command that unblocks it, and the
read-only reconnaissance that was completed so the next session starts at the
test run instead of re-discovering the roster sites.

---

## 1. The blocker (observed, not inferred)

Under the Capability Evolution profile (runtime Policy V14), every path this port
needs was denied at the harness layer:

| Attempted | Result |
|---|---|
| `mise exec bun@latest -- bun run test` | denied — *"permits only allowlisted read-only shell inspection before managed construction"* |
| `mise exec bun@latest -- bun run test 2>&1 \| tail` | denied — redirect target `&1` outside temp dir |
| `sed -n '36,169p' docs/dsh-port/07-handoff.md` | denied — `sed` not allowlisted |
| one `subagent` probe (`bun --version`) | denied — *"denies ordinary model, subagent, agent, and workflow delegation before a managed construction grant"* |

Read-only commands (`ls`, `grep`, `rg`, `cat`, `wc`, `git status|diff|show|log`,
and pipes between them) **do** work, which is how §3 below was produced.

**Consequence:** G1's core requirement — run gstack's own suite — is
unachievable in that profile, and so are G2–G4 (all require build/run). The
`subagent` tool is also denied, so the work cannot be delegated to a child
session either. This is a profile-level policy, not a per-command hiccup, and it
is not something to route around.

**Operator decision:** prepare the switch command and the plan; re-run the task
under the `web` profile (which has unrestricted shell and is the profile the port
was built under).

## 2. The unblock

The switch is a **client-side invocation choice** — the profile is selected when
`dsh` starts; an already-running session cannot change its own policy plane.

```bash
cd /home/matt/src/gstack-dsh
dsh --profile web
```

Confirm the target before re-running the task:

```bash
dsh --profile web --dump-config | grep -i gstack-dsh   # the plugin row must appear
```

`~/.dsh/profiles/` contains exactly `acp`, `headless`, `web`. There is **no**
`capability-evolution` profile directory (consistent with 07-handoff §7):
"Capability Evolution" is a profile/preset *mode*, and the only profile on this
machine that is bootable with this work installed is `web`.

Then re-issue the original request. The task text already names the runner:

```bash
cd /home/matt/src/gstack-dsh
mise exec bun@latest -- bun run test        # gstack's strict parallel free suite
```

## 3. G1 recon completed (read-only)

### 3a. Sites that genuinely must change

| # | Site | Required change | Confidence |
|---|---|---|---|
| 1 | [test/host-config.test.ts:37](test/host-config.test.ts#L37) | `ALL_HOST_CONFIGS.length` `10` → `11` | **certain** — the assertion the brief names |
| 2 | [test/host-config.test.ts:50-59](test/host-config.test.ts#L50-L59) | re-export assertions test only 8 of 11 hosts; add `hermes`, `gbrain`, `dsh` | **certain** — `dsh` is exported at [hosts/index.ts:69](hosts/index.ts#L69) and never asserted |
| 3 | [test/gen-skill-docs.test.ts:4440](test/gen-skill-docs.test.ts#L4440) | `hostDirs` is a hardcoded 8-entry list and **omits `.dsh`**; add `.dsh` or derive `ALL_HOST_CONFIGS.map(c => c.hostSubdir)` | **certain** — `.dsh` is a real `hostSubdir` ([hosts/dsh.ts:46](hosts/dsh.ts#L46)), so the scan currently skips the newest host tree |

Site 3 is the one with teeth beyond bookkeeping: it is the guard that no
`## Plan Mode Handshake` marker leaks into a host render, and it silently skips
`.dsh`. If the cheap fix is taken, prefer deriving the list from
`ALL_HOST_CONFIGS` so a 12th host cannot repeat this.

### 3b. Sites the handoff listed that do **not** need a dsh change

- [test/brain-sync.test.ts:208](test/brain-sync.test.ts#L208) — `spoolFiles().length === 10`
  is **10 enqueue procs** (the loop at :197), unrelated to hosts. No change.
- [test/test-free-shards.test.ts:720](test/test-free-shards.test.ts#L720) — `shards.length === 10`
  is **10 shards**, unrelated to hosts. No change.
- [test/setup-prune-stale-generated.test.ts:94-105](test/setup-prune-stale-generated.test.ts#L94-L105) —
  this asserts gstack's *own* `setup` contains `_prune_stale_generated` call sites
  for `.agents`/`.factory`/`.opencode`/`.cursor`/`KIRO_DIR`. `dsh` is a
  **render-only host with no installer** by design ([hosts/dsh.ts:4-14](hosts/dsh.ts#L4-L14)),
  so `setup` correctly has no `.dsh` call site. No change — but re-run to confirm.

### 3c. Assertions already verified green by inspection

- [test/host-config.test.ts:611-615](test/host-config.test.ts#L611-L615) — every host
  needs `runtimeRoot.globalSymlinks` containing `bin` **and** `ETHOS.md`.
  `dsh` satisfies both ([hosts/dsh.ts:106-111](hosts/dsh.ts#L106-L111)).
- [test/host-config.test.ts:510-515](test/host-config.test.ts#L510-L515) — `claude` is the
  only `real-dir-symlink` host; `dsh` is `symlink-generated`
  ([hosts/dsh.ts:113-115](hosts/dsh.ts#L113-L115)). Green.
- [test/host-config.test.ts:92-105](test/host-config.test.ts#L92-L105) — unique name /
  `hostSubdir` / `globalRoot`. `dsh` uses `.dsh` and `.dsh/skills/gstack`; unique. Green.
- `scripts/host-config-export.ts validate` — reports `All ${ALL_HOST_CONFIGS.length} configs valid`,
  so it has already printed **"All 11 configs valid"**. No hardcoded 10 here.

### 3d. Not yet checked — needs the run

The remaining files 07-handoff §5 named (`test/qa-lazy-sections.test.ts`,
`test/setup-sections-linking.test.ts`, `test/gen-skill-docs-idempotency.test.ts`,
`test/setup-windows-rerun-refresh.test.ts`, `test/setup-runtime-lib-command.test.ts`)
were grepped for host counts and show only **derived** forms —
e.g. [test/qa-lazy-sections.test.ts:340](test/qa-lazy-sections.test.ts#L340) uses
`toBeGreaterThanOrEqual(ALL_HOST_CONFIGS.length)` — which scale automatically.
Treat them as *expected clean* and let the suite decide.

### 3e. Export assertion the handoff flagged (G6)

[test/host-config.test.ts:383-408](test/host-config.test.ts#L383-L408) pins `symlinks`
output for `codex` and `opencode` only. There is no `dsh` case. Given `dsh`
returns five entries including a nested `review/` file
([hosts/dsh.ts:106-111](hosts/dsh.ts#L106-L111)), add a `dsh` case to G6 rather
than assuming the `opencode` case covers it.

## 4. Suggested G1 sequence (in the web profile)

1. `mise exec bun@latest -- bun run test` — get the **real** baseline failure list.
   Do not fix from this document alone; §3 narrows the search, it does not replace
   the run.
2. Apply sites 3a-1…3a-3, deriving site 3 from `ALL_HOST_CONFIGS` if trivial.
3. Re-run. Then `mise exec bun@latest -- bun run scripts/host-config-export.ts validate`
   (expect `All 11 configs valid`).
4. Only after G1 is green, regenerate renders —
   `mise exec bun@latest -- bun run scripts/gen-skill-docs.ts --host dsh` — and
   confirm 57 skill dirs under `.dsh/skills` still render with `gstack-*` frontmatter
   `name:` and populated `whenToUse`.

**Generator trap:** do not run the generator under plain Node. It uses
`import.meta.dir` / `Bun.*` and extensionless relative imports fail. Always
`mise exec bun@latest -- bun run …` (07-handoff §6).

### 4a. Prerequisite: `node_modules` was missing (this invalidated the first run)

The first post-switch attempt at step 1 produced a wall of errors that looked like
port breakage but were **entirely environmental**. Root cause, verified by
inspection: **`node_modules/` did not exist in this working tree at all**
(`ls -d node_modules` → `No such file or directory`).

Every error class observed was that single cause:

- `Cannot find package 'playwright' | 'diff' | 'sharp' | 'socks'`
- `Cannot find module '@anthropic-ai/sdk' | '@anthropic-ai/claude-agent-sdk'`
- `ENOENT … node_modules/playwright-core/package.json` — the file cannot exist
- `error: clang is required for the POSIX metadata regression`
- the whole `bun-polyfill` failure block

**Fix before re-running anything:**

```bash
cd /home/matt/src/gstack-dsh
mise exec bun@latest -- bun install
```

This also **applies the required patch**: `package.json` declares
`patchedDependencies: { "playwright-core@1.62.1": "patches/playwright-core@1.62.1.patch" }`.
The failing `playwright-core windowsHide patch (#2160, #1989)` tests assert that
patch is present *in the installed tree*, so they cannot pass until install has
run. Do not "fix" those tests — they are correct and were reporting a true absence.

**CPU saturation is expected, not a hang.** `bun run test` spawns
`maxFullSuiteJobs()` shard processes concurrently — 16 on Linux, 6 on macOS
([scripts/test-free-shards.ts:487-492](scripts/test-free-shards.ts#L487-L492)) —
across 914 files. Override it with `GSTACK_FREE_JOBS` (documented at
[scripts/test-free-shards.ts:476](scripts/test-free-shards.ts#L476)):

```bash
GSTACK_FREE_JOBS=4 mise exec bun@latest -- bun run test
```

For G1, do **not** start with the full suite — it is the most expensive way to
learn three assertions are off by one. Run the two files that matter first:

```bash
mise exec bun@latest -- bun test test/host-config.test.ts
mise exec bun@latest -- bun test test/gen-skill-docs.test.ts
```

Only then the full suite, once, on the frozen edit.

---

## 4b. G1 outcome — the two host files are green (executed, not inferred)

`bun install` ran, then both named files were executed under the `web` profile.

| File | Before | After |
|---|---|---|
| `test/host-config.test.ts` | 74 pass / 2 fail | **76 pass / 0 fail** (331 assertions, was 305) |
| `test/gen-skill-docs.test.ts` | 461 pass / 0 fail | **461 pass / 0 fail** (8010 assertions, was 7896) |

`gen-skill-docs` needed no behavioral change — it was already green, including the
parameterized **DeepSeek Harness (`--host dsh`)** smoke tests, `--host all`, and
`--dry-run freshness`. That last one matters: it is byte-level proof that the
rendered `.dsh/skills` tree matches a fresh render.

The two real failures were both **stale contract assertions** that encoded
"11th host does not exist", not defects in the port:

1. `test/host-config.test.ts:37` — `length === 10`.
2. `test/host-config.test.ts:503` — titled *"existing hosts retain Claude overlay"*
   but asserted `defaultModel === 'claude'` for every non-Codex host. `dsh` is
   legitimately `deepseek` (registered family in `scripts/models.ts`, overlay at
   `model-overlays/deepseek.md`). Rewritten to name the non-Claude overlay hosts
   explicitly — `{ codex: 'gpt', dsh: 'deepseek' }` — so a *third* host with a
   typo'd model still fails, and extended with two real invariants:
   `resolveModel(host.defaultModel) !== null`, and the overlay file must **exist**.
   The second closes a silent hole: `readOverlay()` returns `''` for a missing
   file, so a host could render with no behavioral overlay and nothing would fail.

Also applied while here (both were genuine gaps, neither was failing):

3. `test/host-config.test.ts:50` — re-export assertions covered 8 of 11 hosts;
   added `hermes`, `gbrain`, `dsh`.
4. `test/gen-skill-docs.test.ts:4440` — `hostDirs` was a hardcoded 8-entry list
   that **omitted `.dsh`**, so the vestigial-handshake guard silently skipped the
   newest host tree. Now derived: `getExternalHosts().map(h => h.hostSubdir)`.
   Assertion count rose 7896 → 8010, which is the scan actually widening.

### Still required before G1 can be called done

**The full suite has not been run.** 914 files exist; 2 are verified. The next
action is the one command below, at reduced parallelism so it does not pin the
CPU. Do not treat G1 as complete until it reports.

```bash
GSTACK_FREE_JOBS=4 mise exec bun@latest -- bun run test
```

Expect a residual tail of unrelated failures even when passing: tests needing
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` will lack them, and Aside/macOS-gated
tests self-skip. Judge G1 on host-related failures only.

---

## 4c. Full-suite triage (run executed; failures classified)

`GSTACK_FREE_JOBS=4 bun run test` completed: 914 files, 5 shards, ~585s worst case.
All five shards exited non-zero. Raw counts — 146 / 109 / 101 / 25 / 29 failing
tests across 18 / 18 / 14 / 11 / 1 files. **The headline number is misleading: it
is a small number of root causes, and only one of them is port-attributable.**

### R1 — vendored-fixture copy omits untracked `hosts/dsh.ts` (THE port failure)

Symptom, repeated ~35 times across `test/setup-codex-scope*.test.ts`:

```
error: Cannot find module './dsh'
  from '<tmp>/project-a/.claude/skills/gstack/hosts/index.ts'
```

Root cause: `test/helpers/setup-codex-scope-fixture.ts:9` builds the fixture's
source list from `git ls-files -z`, which reports **tracked files only**. The port
added the untracked file `hosts/dsh.ts` and wired it into the *tracked*
`hosts/index.ts`, so every fixture copy got a `hosts/index.ts` whose `import dsh
from './dsh'` resolves to nothing. The `setup` call dies before any assertion runs.

The fixture already hand-lists untracked files for exactly this reason
(`scripts/external-skill-names.ts`, `scripts/preflight-codex-overlap.ts`).

**Fix applied** — added `hosts/dsh.ts` and `model-overlays/deepseek.md` to that
hand-listed set.

This is a *test-harness* limitation, not a product defect, and it resolves itself
once the port is committed (`git ls-files` then sees both files). Until then the
explicit entries are required. If the port is never committed, that list is the
only thing keeping these suites alive.

### R1b — two more registry-wide invariants that catch the same class

Both are genuine port omissions: each derives its expectation from
`ALL_HOST_CONFIGS`, so a new host cannot be added without satisfying them.

**`test/setup-help.test.ts:91` — the #2361 cross-check.** Requires *every*
registered host to have a dispatch arm in `setup`'s `case "$HOST" in` — either an
install arm (a `a|b|c)` pipe list) or an informational arm (a single name). `dsh`
had neither, so `./setup --host dsh` fell through to `*)` and exited 1.

Fixed by adding a `dsh)` informational arm alongside `slate`/`openclaw`/`hermes`/
`gbrain`, explaining that dsh is render-only and that `.dsh/skills` discovery *is*
the install. Also updated the two host lists (the `--host` missing-value error and
the unknown-host error) plus the `usage()` text — four copies of the same roster,
none of which any test pins.

**`test/routing-probe.test.ts:107` — the team-init probe list.** Requires
`$HOME/<globalRoot>` for every registered host to appear in `bin/gstack-team-init`.
`$HOME/.dsh/skills/gstack` was absent from both probe loops (lines 84 and 138).

Note the mild fiction this preserves: every other entry in those loops is a
machine-global root, whereas `.dsh/skills/gstack` is project-scoped by design
(`hosts/dsh.ts` says so explicitly). The probe is harmless — it only tests
`[ -d "$_D/bin" ]` — and the test legitimately demands registry coverage, so the
entry is correct even though the path is never where that loop will find it on a
real machine.

**Neither of these was reachable from the two host files.** They only surface
when the whole registry is enumerated, which is why the first focused run was
green while the suite was not.

### R2 — environmental, unrelated to the port (the large majority)

None of these can pass on this machine, with or without the port:

| Cluster | Cause |
|---|---|
| ~80 `browse/test/*` + `test/qa-only-cleanup` + `test/daemon*` | Chromium never downloaded — `~/.cache/ms-playwright/chromium_headless_shell-1234/...` absent. Fix: `bunx playwright install chromium` |
| `browse/test/xvfb.test.ts` (~10) | `Xvfb` not in `$PATH` |
| `test/bootstrap-retention`, `freeze-owned-lifecycle`, `team-mode`, `session-update-autostash`, `ship-hook-refresh`, `ci-paid-coordination` (~60) | `error: Author identity unknown` — no `git config user.name/user.email` here; every fixture that shells `git commit` fails |
| ~250 `test/cso-*`, `test/private-state-*` | CSO suite needs Docker + compiled binaries + network; `docs/TESTING_INTERNALS.md` treats these as qualified-profile only |
| `test/test-value-bar`-adjacent POSIX probes | `clang` not installed |

### R3 — baseline resolved: both are PORT-ATTRIBUTABLE, not pre-existing

The baseline was run. Both files **pass without the port and fail with it**:

| File | Port stashed | Port active |
|---|---|---|
| `test/devex-finding-fixture.test.ts` | 1 pass / 0 fail | 1 fail |
| `test/plan-review-cases.test.ts` | 219 pass / 0 fail | 1 fail |

So the earlier guess that these were pre-existing noise was **wrong**, and the
guess that only the two host files were affected was **wrong**. Two more members
of the same class (a hardcoded/enumerating assumption that the 11th host fails):

**R3a — `test/devex-finding-fixture.test.ts:14`, root-anchored regex. FIXED.**
The filter matched `(?:^|\/)gstack-plan-devex-review\/SKILL\.md$`. Every other
host renders `<hostSubdir>/skills/gstack-<skill>/SKILL.md`, but **dsh's
hostSubdir IS a skills root** (`.dsh/skills`), so it renders one level deeper:
`.dsh/skills/gstack-plan-devex-review/SKILL.md`. That has text before `gstack-`,
so it matched neither alternative and dsh was silently dropped, leaving a
10-host list to be compared against 11 `ALL_HOST_NAMES`. The artifact was
present on disk all along — verified: `.dsh/skills/gstack-plan-devex-review/SKILL.md`
exists. Loosened the anchor to `(?:^|\/)` for the skill segment.

Note the trap: `dsh` is the only host whose `hostSubdir` is itself a skills root,
so it is the only host that renders at depth 2. Any test pattern anchored to the
path start will silently under-collect it. Grep for other `SKILL\.md$` patterns
with a `^` anchor when adding a 12th host.

**R3b — `test/plan-review-cases.test.ts:346`, carrier ordering. UNRESOLVED.**
The carrier filter at :330-332 uses `.endsWith('/gstack-<skill>/SKILL.md')`, so it
correctly INCLUDES dsh (33 carriers = 4 plans × 11 hosts). The failure is the
ordering invariant `report < readback < log < dashboard` on some carrier. The
on-disk `.dsh` and `.agents` renders have identical heading order (regenerate into
the test's own temp root, so on-disk trees are not the evidence). Needs the
probe's per-carrier offsets to name the violating carrier — do not guess.

### Sequencing note

R1 was fixed by a single edit. Re-run only the affected files first:

```bash
mise exec bun@latest -- bun test test/setup-codex-scope.test.ts test/setup-help.test.ts
```

Working-tree state after these edits (`git status --short`):

```
 M .gitignore              M hosts/index.ts          M scripts/gen-skill-docs.ts
 M scripts/host-config.ts  M scripts/models.ts       M test/gen-skill-docs.test.ts
 M test/host-config.test.ts
?? .dsh/                                              <- contains node_modules (gitignored)
?? docs/dsh-port/  ?? hosts/dsh.ts  ?? model-overlays/deepseek.md
```

`node_modules/` is now present and untracked/ignored; expect it in `git status`
during development and never stage it.

## 5. G5 — approved scope, not yet applied

Operator approved **exactly the two entries the handoff flagged**, and nothing
else in that shared file. Apply only after the profile switch:

- `~/.dsh/profiles/web/cordis.patch.yml:441` → remove `- id: deepseek/deepseek-v4-pro`
  (with its `name`/`contextWindow`/`maxTokens`/`input` block)
- `~/.dsh/profiles/web/cordis.patch.yml:447` → remove `- id: deepseek/deepseek-v4-pro-0813`
  (with its block)

Ground truth from recon, so the edit is unambiguous:

- Line 441 is the start of the `deepseek/deepseek-v4-pro` row; the block ends at
  line 446 (`input: - text`), with the next row `deepseek/deepseek-v4-pro-0813`
  beginning at 447.
- The port's own artifacts are **clean**. `grep -r deepseek-v4-pro .dsh` returns
  only: the dated backup `.dsh/backups/profile-cordis.patch.yml.orig:441,447`, a
  policy comment at [.dsh/plugin/lib/escalation.js:263](.dsh/plugin/lib/escalation.js#L263)
  explaining the deliberate omission, and a **negative** assertion at
  [.dsh/plugin/test/unit.test.js:333](.dsh/plugin/test/unit.test.js#L333).
  Keep all three; the two `.js` hits are load-bearing evidence, not leakage.
- Out of scope by the operator's choice: the backup file, and any other v4-pro
  variant in that YAML. Do not widen the edit.

**Free-Jev constraint still holds:** Jev stays on OpenCode's free endpoint. Do not
touch its route while editing this file (07-handoff §1, operator constraint).

## 6. Remaining work unchanged

G2 (escalation dispatch), G3 (browse engine for Linux), G4 (pipeline disk
persistence), G6 (README section + `dsh` symlinks case) are described in
[07-handoff.md §5](docs/dsh-port/07-handoff.md#L96-L136) and are untouched by this
session. G3 remains the largest capability gap. All four need the web profile.

## 7. Trust boundary for this document

Everything in §3 and §5 was read directly from this working tree and from
`~/.dsh/profiles/web/cordis.patch.yml` by read-only inspection. **No test, build,
or generator was executed**, so §3a–§3d are static analysis, not verified results.
Treat §4 step 1 as authoritative and this document as a head start.
