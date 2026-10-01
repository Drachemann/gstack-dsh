# 10 — Upstream mergeability

`docs/ADDING_A_HOST.md` promises that adding a host is **one file plus a
re-export — zero changes to the generator, setup, or tooling**. That promise
holds for a host that is a pure translation of the existing shape. The
DeepSeek Harness is not one, and this document says exactly where and why, so a
future `git merge origin/main` (or an upstream PR) is a review of five small
deltas rather than an archaeology exercise.

Rule of thumb for every change below: **additive, host-gated, and inert for
every host that did not opt in.** Nothing here changes another host's rendered
bytes, which is what keeps merges cheap.

---

## 1. Pure host addition (merge-proof)

| Artifact | Notes |
|---|---|
| `hosts/dsh.ts` | Whole file is the host definition |
| `hosts/index.ts` | One import + one export (the documented "re-export") |
| `model-overlays/deepseek.md` | New file, reached only when `--model deepseek` |
| `scripts/models.ts` | One entry in `ALL_MODEL_NAMES` |
| `docs/dsh-port/**` | New files, no existing-doc edits |

These merge cleanly: upstream has no reason to touch them, and a conflict here
means upstream also added a host (resolve by keeping both).

## 2. Shared-file deltas that need a reason

### 2.1 `scripts/host-config.ts` — new optional field

```ts
localSkillRootProbe?: string;   // path relative to localSkillRoot
```

Generic, default-unset, and host-neutral: "prefer a project-local install only
once a probe file proves it is usable." Upstream-shaped as-is — it is not a dsh
special case, it just has dsh as its first consumer. **Verdict: propose upstream
independently of dsh.**

### 2.2 `scripts/resolvers/preamble/generate-preamble-bash.ts`

One conditional. With no `localSkillRootProbe`, the emitted line is
byte-identical to before, so every committed Claude/Codex/Factory/… render is
untouched. `test/gen-skill-docs.test.ts > probe-less hosts keep the historical
unconditional local preference` pins that.

### 2.3 `setup` — a real `--host dsh` install arm

This is the largest delta and the one most likely to conflict, because upstream
edits `setup` constantly. It is deliberately shaped like the existing
`codex` / `kiro` / `factory` / `opencode` / `cursor` arms:

- `INSTALL_DSH` flag + `auto` detection (`command -v dsh`), same as the others;
- the no-install-arm guard lists `INSTALL_DSH`, so dsh cannot silently no-op;
- path vars next to `CURSOR_*` / `KIRO_*`;
- `create_dsh_runtime_root()` / `link_dsh_skill_dirs()` next to
  `create_codex_runtime_root()` / `create_factory_runtime_root()`;
- one install block after the Cursor block.

Three small edits sit *outside* the arm and are Claude-only guards:
the gbrain-detection block and the plan-tune hook block now run only when
`INSTALL_CLAUDE=1`. Those are **bug fixes independent of dsh** (a
`--host codex` run could previously delete the Claude render directory), so
they are good upstream candidates on their own.

**Merge-hygiene rule for this file:** never restructure the dsh arm to
"fit better"; keep it a sibling of the other host arms so an upstream conflict
is a same-shape three-way merge. If upstream refactors the arms, follow it.

### 2.4 `scripts/resolvers/gbrain.ts` + `scripts/resolvers/index.ts`

`{{GBRAIN_MCP_REGISTER}}` is a new resolver; Step 5a's body moves out of
`setup-gbrain/SKILL.md.tmpl` into it. The Claude branch is the previous text,
unchanged in substance. Also host-neutral (any future host can add a branch),
and the template becomes smaller. **Verdict: upstream-shaped.**

### 2.5 `scripts/resolvers/review-army.ts`

One `ctx.host === 'dsh'` branch that swaps the dispatch vocabulary. Host-neutral
in structure — it is the same pattern the file already uses for `codex` (which
returns `''`). The substantive claim is that dsh's `subagent` has
`description`/`prompt`/`run_in_background` and **no** `subagent_type`.

### 2.6 `hosts/dsh.ts` resolver suppression + tool rewrites

`suppressedResolvers: ['CODEX_SECOND_OPINION', 'CODEX_PLAN_REVIEW']` — the other
three `CROSS_MODEL_RESOLVERS` are kept because each has a native in-host
subagent pass. The tool-rewrite table is a data table; conflicts are additive.

### 2.7 `make-pdf` was missing everywhere an env-var host looks for it

`scripts/resolvers/types.ts:55` sets `makePdfDir: '$GSTACK_MAKE_PDF'` for every
`usesEnvVars` host (all but Claude), and `scripts/resolvers/make-pdf.ts` falls
back to `"$GSTACK_MAKE_PDF/pdf"`. **Nothing ever defined that variable**, and the
dsh runtime root never linked `make-pdf`. Result: `/gstack-make-pdf` printed
`MAKE_PDF_NOT_AVAILABLE (P='/pdf')` on dsh, codex, factory, kiro, cursor and
opencode — every non-Claude host.

Three edits, all additive:

- `scripts/resolvers/preamble/generate-preamble-bash.ts` — one more env-var line,
  next to `GSTACK_BROWSE` / `GSTACK_DESIGN`.
- `setup` — `make-pdf` added to the dsh asset loop.
- `hosts/dsh.ts` — `make-pdf` added to `globalSymlinks`.

**Merge note, recorded rather than glossed:** unlike every other delta in this
document, the preamble line is **not** host-gated — it changes the rendered bytes
of every env-var host, which is why `test/fixtures/golden/{codex,factory}-ship-SKILL.md`
were refreshed in the same commit. The alternative (a dsh-only line) would knowingly
leave the same one-line defect on five other hosts. The diff is a single line and
the goldens make it visible; it is a good standalone upstream candidate, like the
Claude-only guards in §2.3.

### 2.8 `scripts/resolvers/dsh-upgrade-guard.ts` — new file, dsh-only

`{{DSH_UPGRADE_GUARD}}` returns the Step 2 heading verbatim for every non-dsh
host, so their rendered bytes are byte-identical (pinned by the unchanged Claude
`gstack-upgrade/SKILL.md` render). Only dsh gains the symlink-farm detection
described in `11-install-and-use.md` §5. The template line it replaces is the
Step 2 heading itself, which is why no other host sees a stray blank line.

## 3. Merge checklist

Run this after every `git merge origin/main` (or before opening an upstream PR):

```bash
bun run scripts/host-config-export.ts validate       # all configs still valid
bun run gen:skill-docs                               # regenerate committed renders
bun run gen:skill-docs --host dsh                    # regenerate the dsh tree
./setup --host dsh </dev/null                        # install + runtime roots
bun test test/host-config.test.ts test/gen-skill-docs.test.ts \
         test/setup-gbrain-path4-structure.test.ts test/gstack-skill-start.test.ts
bun run test:plugin                                   # node --test; bun cannot see .dsh/
bun run test:quick
```

Then confirm the dsh invariants by hand — they are cheap and they are exactly
what a bad merge breaks:

```bash
# 1. The preamble runs (this is the whole point of the install).
bash -c '_ROOT=$(git rev-parse --show-toplevel); GSTACK_ROOT="$HOME/.dsh/skills/gstack";
[ -n "$_ROOT" ] && [ -x "$_ROOT/.dsh/skills/gstack/bin/gstack-skill-start" ] && GSTACK_ROOT="$_ROOT/.dsh/skills/gstack";
"$GSTACK_ROOT/bin/gstack-skill-start" --skill review --model deepseek --parent-pid $$' | head -1
# expect: SKILL_START_PROTO: 1

# 2. Step 1 of the brain workflow runs.
.dsh/skills/gstack/bin/gstack-gbrain-detect | grep gbrain_local_status

# 3. No Claude-only tool names survived the render.
grep -rl 'ExitPlanMode\|subagent_type: "' .dsh/skills        # expect: no output
grep -rl 'claude mcp add --scope user' .dsh/skills/gstack-setup-gbrain  # expect: no output
```

`test/gen-skill-docs.test.ts > dsh host render` pins all three statically, so a
merge that breaks them fails the suite rather than shipping.

## 4. Things deliberately left divergent

- **`setup` does more than `ADDING_A_HOST.md` documents.** The doc's "zero
  changes" promise assumed a host whose skills are self-contained. dsh skills
  shell out to `$GSTACK_ROOT`, so an install arm is unavoidable. Worth an
  upstream doc amendment if the dsh work is proposed.
- **`allowed-tools` has no dsh equivalent.** Real capability loss on this host,
  not a translation. Stated in `hosts/dsh.ts`, not papered over.
- **`gstack-codex` / `gstack-claude-code` remain rendered** although neither CLI
  exists on a dsh-only machine. `03-gap-analysis.md` §2 recommends suppressing
  them the way `hosts/codex.ts` skips its own wrapper. That is a visible
  capability removal, so it is the operator's call, not a silent port decision.
- **Bare `/ship` references** (`/ship` vs the registered `gstack-ship`, 1052
  hits in 55 skills) are unresolved and currently work only because the sibling
  `.agents/skills` render registers bare names. Any fix has to be decided
  together with whether that tree stays.

## 5. Residue a reviewer should know about

`grep -rn '\bAgent\b' .dsh/skills` still finds a handful of hits (English prose
like "Agent Onboarding", plus host-conditional lines in `gstack-autoplan` that
name "Claude Code:" inside a cross-host block). None of them instructs a tool
call that cannot be made; the tool-name rewrites cover every dispatch site. They
are listed here rather than silently cleaned so a future pass can decide.
