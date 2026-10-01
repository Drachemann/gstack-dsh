# 09 — Workflow verification: `/setup-gbrain` under dsh

**Verdict: the port did not survive its first real workflow, and the reason was
one level below `setup-gbrain`.** Running the rendered preamble verbatim
aborted before any skill logic executed. This document records what was tested,
what was actually broken, what changed, and what is still unproven.

`07-handoff.md` claims "all five live paths verified" and "full skill parity".
Both remain true of the **plugin** (decision tools, Jev binding, pipeline,
escalation). Neither was true of the **skills**: they were verified as text
(frontmatter, path rewrites, no `AskUserQuestion` leakage), never executed.

---

## 1. The reproduction

Every rendered dsh skill opens with the same preamble. Executed verbatim from
the project root:

```bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
GSTACK_ROOT="$HOME/.dsh/skills/gstack"
[ -n "$_ROOT" ] && [ -d "$_ROOT/.dsh/skills/gstack" ] && GSTACK_ROOT="$_ROOT/.dsh/skills/gstack"
_SS="$GSTACK_ROOT/bin/gstack-skill-start"
[ -x "$_SS" ] || _SS=".dsh/skills/gstack/bin/gstack-skill-start"
"$_SS" --skill setup-gbrain --model deepseek --parent-pid "$PPID"
```

Before the fix:

```
GSTACK_ROOT=/home/matt/src/gstack-dsh/.dsh/skills/gstack
SKILL_START: unavailable
bash: .dsh/skills/gstack/bin/gstack-skill-start: No such file or directory
```

Root cause, two layers deep:

1. `.dsh/skills/gstack/` contained **only `SKILL.md`**. No `bin/`, no `lib/`,
   no `browse/`, no `docs/`. `hosts/dsh.ts` described `runtimeRoot` as
   "documentation-grade" and `./setup --host dsh` printed "there is nothing for
   `./setup` to install" and exited 0. Rendering was treated as installing.
2. The `_ROOT` override tests only `-d "$_ROOT/.dsh/skills/gstack"` — a
   directory the *render itself* creates. So even with a healthy global install,
   a half-populated project render shadowed it silently.

An inventory of the rendered corpus (`.dsh/skills`, 57 SKILL.md) found **740
references to 72 distinct `$GSTACK_ROOT/<path>` values**. All 72 exist in the
repo; all 72 were missing at the install root. Nothing was absent — everything
was relocated. That is why a structural frontmatter/path-rewrite audit passed
and the skills still could not run a single command.

Confirmed first victim, and the workflow this task set out to verify:
[gstack-setup-gbrain/SKILL.md:66](.dsh/skills/gstack-setup-gbrain/SKILL.md#L66)
runs `$GSTACK_ROOT/bin/gstack-gbrain-detect` as Step 1.

## 2. What changed

| # | Change | File |
|---|---|---|
| 1 | `--host dsh` is a real install target: renders the tree, then builds **two** runtime roots (project `.dsh/skills/gstack`, global `$DSH_HOME/skills/gstack`) and links each rendered skill into the global root | [setup:2753](setup#L2753) |
| 2 | `create_dsh_runtime_root()` — links the observed `$GSTACK_ROOT/<path>` asset set | [setup:2088](setup#L2088) |
| 3 | `link_dsh_skill_dirs()` + `_prune_stale_generated` for the global root | [setup:2123](setup#L2123) |
| 4 | Preamble only prefers a project-local root when the **launcher probe** exists there | [generate-preamble-bash.ts:29](scripts/resolvers/preamble/generate-preamble-bash.ts#L29), [dsh.ts:139](hosts/dsh.ts#L139) |
| 5 | `runtimeRoot.globalSymlinks` is now the real 16-entry asset set | [dsh.ts:148](hosts/dsh.ts#L148) |
| 6 | `ExitPlanMode` → `exit_plan_mode` (122 hits / 50 skills; the `/ship` plan gate blocked on a tool that cannot be called) | [dsh.ts:83](hosts/dsh.ts#L83) |
| 7 | `subagent_type` dispatch sites rewritten (dsh `subagent` has no such field, so the call would be rejected) | [dsh.ts:85](hosts/dsh.ts#L85) |
| 8 | `/setup-gbrain` Step 5a is host-rendered: dsh writes `$DSH_HOME/mcp.json`, Claude Code keeps `claude mcp add` | [gbrain.ts:381](scripts/resolvers/gbrain.ts#L381) |
| 9 | dsh install no longer touches Claude-only state (plan-tune hooks, Claude render dir) | [setup:3053](setup#L3053), [setup:3107](setup#L3107) |

### The non-obvious one: the review army

`hosts/dsh.ts` suppressed **every** `CROSS_MODEL_RESOLVER`, on the reasoning that
dsh cannot run gstack's cross-harness shell-outs. That is right for the two
Codex-invocation resolvers and wrong for the other three:

- `REVIEW_ARMY` dispatches parallel specialist **subagents** — precisely what
  dsh's `subagent` tool is for.
- `ADVERSARIAL_STEP` and `DESIGN_OUTSIDE_VOICES` are each a native in-host
  subagent pass **plus** an optional Codex second opinion. Suppressing the
  resolver dropped the native pass with the Codex one.

Suppression is now `['CODEX_SECOND_OPINION', 'CODEX_PLAN_REVIEW']`, and
`review-army.ts` renders dsh-shaped dispatch instructions (no `subagent_type`,
`run_in_background: false`, resolve backgrounded children with `job_output`
rather than a `wait_agent` timeout). `/gstack-review` and `/gstack-ship` regain
their specialist lanes.

GBrain resolvers are likewise no longer suppressed, mirroring `hermes.ts`. The
old default meant a user could complete `/setup-gbrain` successfully and still
get zero brain-aware skills, because suppression is decided at render time.
The brain blocks degrade to "proceed without brain context" when no brain is
configured.

## 3. Evidence

**Preamble now runs.** `gstack-skill-start` returns `SKILL_START_PROTO: 1`, a
`SESSION_ID`, and the full STATUS block — previously the hard abort above.

**Step 1 of the workflow runs.** `gstack-gbrain-detect` returns
`gbrain_local_status: "no-cli"`, which is exactly the value the skill's Step 1
branches on. (This machine has no `gbrain` binary; that is the honest starting
state, and the skill is designed for it.)

**The dsh MCP registration path is proven at three levels.**

1. `dsh-mcp` is **not** a usable route: not on PATH, and
   `node .../lib/cli.js` aborts with `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-scope`
   (the peer only resolves inside the DSH install tree). The skill therefore
   writes the config layer directly and says so.
2. The writer preserves unrelated top-level keys and unrelated MCP servers,
   refuses to overwrite invalid JSON (leaves the file untouched, exits 1), and
   writes the bearer as a literal `${GBRAIN_MCP_TOKEN}` placeholder.
3. The plugin's own loader accepts the result: `readDshJsonFile` returns one
   valid `@deepseek-ai/dsh-mcp-client` row with
   `transport: streamable-http` and the header placeholder, `entryErrors: []`.

**Free suite.** `bun run test:quick` → 1768/1769. The single failure,
`test/cso-witness.test.ts > valid external assertions issue a runtime-tested
bundle`, is **pre-existing and unrelated**: it passes alone (3 runs) and 8×
concurrently, and it fails identically in shard 5 with every change in this
document stashed — verified by running the suite on pristine `HEAD`.

## 4. What is still not proven

- **A completed brain.** `gbrain` is not installed here, so no run has reached
  Step 2 (path choice), Step 3 (install), or Step 4 (init). Every command the
  skill would run up to Step 5a resolves; nothing past it has executed.
- **The live MCP mount.** The loader was exercised directly; no DSH restart has
  been observed picking up a `gbrain` row and exposing its tools.
- **The review army end to end.** The instructions render and the tool exists;
  a full specialist fan-out has not been run.
- **Agent-team semantics from inside a skill.** A root session does expose
  `spawn_teammate` / `team_task_*` / `wait_agent`; a delegated subagent exposes
  none of them (`agent-team/lib/index.js:411,420`). The overlay states this, but
  no skill has yet exercised it.

## 5. Deliberately not changed

`gstack-codex` and `gstack-claude-code` remain rendered for parity, although
neither CLI exists on this host and `gstack-claude-code` carries an unfilled
`RUNTIME_ROOT='<gstack-runtime-root>'` placeholder. `03-gap-analysis.md` §2
recommended suppressing them the way `hosts/codex.ts` skips its own wrapper.
That is a visible capability removal, so it is recorded here as a decision for
the operator rather than taken unilaterally. Their preflights report the missing
binary honestly; they do not silently misbehave.

The bare-slash-command gap (`/ship` vs the registered `gstack-ship`, 1052 hits
across 55 skills) is likewise untouched: it currently resolves because the
sibling `.agents/skills` render registers bare names. Removing that tree would
break every bare invocation in the dsh render, so the two must be decided
together.

---

## 6. Dogfood observation: `/gstack-careful`

Running `/gstack-careful` end to end on this repo (the skill loaded from
`.dsh/skills/gstack-careful`, resolved its base directory, executed its bash, and
appended its `~/.gstack/analytics/skill-usage.jsonl` record) confirms the skill
machinery works. It also confirms a host mismatch the gap analysis predicted:

`gstack-careful/SKILL.md` describes its enforcement as a Claude Code hook that
returns `hookSpecificOutput` with `permissionDecision: "ask"`. dsh has no
`PreToolUse` hook mechanism and ignores that payload shape; its authoritative
gate is the Harness approval policy (`user-approval` with
`read-only|workspace-write|danger-full-access` × `ask|never`) plus the
`gstack-dsh` plugin's pre-execution risk gate. So on dsh this skill is
documentation of intent, not an active gate — the honest mapping is "dsh's
policy is authoritative; the skill is a thin wrapper over it."

The same class covers the `ask_user_question` auto-decide hooks, which cannot
fire on dsh at all. Neither is fixed here: both need a decision about how much
of gstack's Claude-hook surface to re-express as dsh policy, and that decision
changes behaviour for every skill.

**Correction (2026-10-02, dogfood lanes).** The line above — "documentation of
intent, not an active gate" — was true when written and is now **stale**. The
dsh render of `/gstack-careful` writes `~/.gstack/careful.json`
(`gstack-careful/SKILL.md:32`), and `.dsh/plugin/lib/index.js` reads that marker
on every gated tool call (`readCareMode`, line 109; consulted at the gate, line
892). Verified from a foreign project: writing the marker the way the skill does
flips `readCareMode()` from `off` to `{mode:'careful', reason:'active'}`, and the
ambiguous band that is merely *observed* with no marker is **blocked** with one.
`/gstack-guard` writes `mode: 'guard'` and `/gstack-unfreeze` removes the file, so
the whole tier is live. What remains true: dsh has no `PreToolUse` hook, and
dsh's approval policy is still authoritative underneath. The auto-decide hook
class is still inert.

---

## 7. Dogfood finding: the runtime root was missing referenced assets

Invoking `/gstack-unfreeze` in a live session failed:

```
bash: /home/matt/.dsh/skills/gstack/freeze/bin/freeze-state.sh: No such file or directory
freeze-state exit=127
```

The runtime root's asset list had been derived by grepping the rendered corpus
for `$GSTACK_ROOT/<path>`. That missed a second reference form. When a template
spells the path `$HOME/.claude/skills/gstack/...` rather than
`~/.claude/skills/gstack/...`, the path rewrites produce a **literal**
`$HOME/.dsh/skills/gstack/<path>` — which bypasses `$GSTACK_ROOT` *and* the
project-local override, so the asset must exist at the global root and nowhere
else. Three assets were unreachable this way:

| Asset | Referenced by | Effect if missing |
|---|---|---|
| `freeze` | `freeze`, `guard`, `unfreeze`, `investigate` | `/unfreeze` and `/guard` exit 127 |
| `extension` | `open-gstack-browser` | the Chrome-extension path fallback never resolves |
| `VERSION` | `ios-sync` | upstream version read fails |

All three are now linked, and a new test scans the rendered dsh tree for **both**
reference forms and asserts every first path segment is in the linked set. That
test found `VERSION` immediately after the first two were fixed — which is the
point: the config↔installer parity test could not catch this class, because both
lists were missing the same entries.

`.git` is deliberately still absent. `gstack-upgrade` probes for it, but its
`elif` chain is written for a non-git runtime root, and linking the source
checkout's `.git` in would let an upgrade mutate the plugin's own git state.

---

## 8. `/gstack-freeze` and `/gstack-guard` are now enforced, not just documented

Section 6 recorded that `/gstack-careful` was inert on dsh. `/freeze` had the
same shape and a worse symptom: `/gstack-unfreeze` exited 127 (missing
`freeze/bin/` at the runtime root — fixed in §7), and even once the writer ran,
nothing read the boundary, because enforcement on Claude Code is a `PreToolUse`
hook.

`.dsh/plugin/lib/freeze.js` is the enforcement arm, checked on the plugin's
pre-execution gate **before** any judgment call — a hard boundary the user set
must not depend on a model's opinion, nor spend a decision to reach a
deterministic answer. It is a mirror of `check-freeze.sh`, not a
reinterpretation, because the two must agree:

| Concern | Mirrored behaviour |
|---|---|
| State root | `GSTACK_HOME` → `CLAUDE_PLUGIN_DATA` (gstack-scoped) → `$HOME/.gstack` → `.gstack` |
| State file | `<root>/freeze-dir.txt`; line 1 boundary, line 2 `gstack-freeze-v1:<owner>`; legacy files trimmed, v1 files taken verbatim |
| Symlinks | the **final** component is followed, bounded at 40 hops — the hook's fix for an in-boundary symlink escaping to an out-of-boundary target |
| Containment | target equals the boundary or starts with `<boundary>/`, so `/src` never matches `/src-old` |
| Polarity | a boundary that cannot be evaluated DENIES; "no state file" means unconfigured and ALLOWS; a non-file tool (no `file_path`) ALLOWS |

Verified end to end through the production path — the real `freeze-state.sh`
writer, the plugin's default state-root resolution, then the gate:

```
read boundary      : {"active":true,"deny":false,"dir":"/tmp/tmp.wLg1XproMA","reason":"active"}
edit INSIDE  boundary : ALLOWED
edit OUTSIDE boundary : DENIED
edit outside (rel cwd): DENIED
bash (out of scope)   : ALLOWED (by design, as in the hook)
```

72 plugin tests pass, including the symlink escape, the prefix-collision case,
and the relative-boundary refusal.

**Known limitations, stated rather than papered over:**

- `bash` is out of scope, exactly as in the Claude hook. This prevents accidental
  edits, not a determined one — `sed` still writes wherever it likes.
- A relative `file_path` is resolved against the process working directory when
  the session cwd cannot be determined, because dsh's file tools expose no cwd
  and the plugin's `exec` carries none. Absolute paths are exact; the skill says so.
