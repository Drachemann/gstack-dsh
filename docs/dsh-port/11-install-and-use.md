# 11 — Install and use gstack-dsh from another project

Answer to "can I install this and use it on my other repos?" Verified by running four
dogfood lanes from foreign `/tmp` git repos against `feat/dsh-host-workflows`
(`f3efe84a` + this branch). Raw evidence:
`/tmp/dogfood-{install,memory,engine,flow,lead}/FINDINGS.md`.

**Short answer: yes, with two caveats.** A dsh install is *user-scoped*, not
project-scoped, and every skill is invoked as `/gstack-*`, not `/ship`.

---

## 1. The working recipe

```bash
# Once per machine. Run it INSIDE the gstack-dsh checkout, not in your project.
cd /home/matt/src/gstack-dsh
./setup --host dsh
```

That renders the dsh tree and builds **two** runtime roots:

| root | what it is | who reads it |
|---|---|---|
| `<checkout>/.dsh/skills` | the project-local render + runtime root | a dsh session whose cwd is the checkout |
| `$DSH_HOME/skills` (default `~/.dsh/skills`) | `gstack/` router + 56 `gstack-*` skill dirs, linked | every other project |

Then, from any other repo, a dsh session resolves the preamble against
`$HOME/.dsh/skills/gstack` and every `/gstack-*` skill works. Verified: run the
rendered preamble block from `/tmp/dogfood-install` (a repo with no `.dsh`) and it
returns `SKILL_START_PROTO: 1` with `CHOSEN_GSTACK_ROOT=/home/matt/.dsh/skills/gstack`.

**Invocation form:** use `/gstack-ship`, `/gstack-review`, `/gstack-context-save`.
Bare `/ship` and `/review` do **not** resolve outside this checkout — see section 3.

---

## 2. What a dsh install actually is

`$DSH_HOME/skills/gstack` is a **symlink farm into the source checkout**, not a copy:

```
~/.dsh/skills/gstack/bin       -> /home/matt/src/gstack-dsh/bin
~/.dsh/skills/gstack/freeze    -> /home/matt/src/gstack-dsh/freeze
~/.dsh/skills/gstack-ship      -> /home/matt/src/gstack-dsh/.dsh/skills/gstack-ship
```

Two consequences worth knowing:

1. **The checkout must stay put.** Move or delete it and the install breaks.
   There is no vendored copy to fall back on.
2. `freeze/bin/freeze-state.sh` sources `../../careful/bin/hook-extract.sh`.
   `careful` is *not* in the linked asset set; the path resolves only because the
   kernel follows `..` through the `freeze` symlink back into the checkout. A
   copy-based install would break `/gstack-freeze`, `/gstack-unfreeze` and
   `/gstack-guard`. Filed in TODOS.md.

`.git` is deliberately absent from the runtime root (doc 09 section 7), which is
why `/gstack-upgrade` needs the guard described in section 5.

---

## 3. Bare names vs namespaced names

dsh's filesystem skill provider scans four roots:

| rank | root | source | what gstack puts there |
|---|---|---|---|
| 100 | `<projectRoot>/.dsh/skills` | `project-dsh` | namespaced (`name: gstack-ship`) |
| 200 | `<projectRoot>/.agents/skills` | `project-agents` | **bare** (`name: ship`) — gitignored, untracked |
| 400 | `$DSH_HOME/skills` | `user-dsh` | namespaced — the only root `setup` links |
| 500 | `$DSH_AGENTS_HOME/skills` (`~/.agents/skills`) | `user-agents` | nothing (never populated) |

So:

- **In this checkout**, both `/ship` and `/gstack-ship` load, because the rank-200
  `.agents/skills` render happens to exist locally. `.gitignore:29` ignores
  `.agents/`, so a fresh clone has none of it.
- **In any other project**, only `/gstack-ship` exists. `setup --host dsh` links
  rank 400 only, and nothing populates rank 500.

The fix is either a bare-name dsh render linked into rank 500, or accepting
`/gstack-*` as the documented form. Filed in TODOS.md as a P1.

### Resolution (corrected 2026-10-02): the prefix is deliberate; the preamble was lying

The first pass filed this as "bare names are missing — add them". That was the
wrong call, and `hosts/dsh.ts:62` says why:

```ts
// dsh's registry keys skills by the frontmatter `name` (it validates and
// de-duplicates on it) and its `/name` gesture matches that same value, so
// the field must carry the host's external name (`gstack-ship`) rather than
// the template's bare name (`ship`). Without this, every generated skill
// would collide with a same-named skill from any other installed pack.
nameField: 'external',
```

So `gstack-*` is intentional collision avoidance in dsh's registry, and
`externalSkillName()` (`scripts/external-skill-names.ts`) prefixes unconditionally.
Bare names must **not** come back.

The actual defect was the STATUS line. `bin/gstack-skill-start` read
`skill_prefix` from `~/.gstack/config.yaml` (here `false`) and echoed
`SKILL_PREFIX: false`, which made the preamble's own rule
("If `SKILL_PREFIX` is `"true"`, suggest/invoke `/gstack-*` names") tell the model
to offer **`/ship`** — a skill dsh never registers, in any project. The install and
the preamble disagreed.

Fixed: `generate-preamble-bash.ts` passes `GSTACK_SKILLS_PREFIXED=true` as a
per-command env assignment for hosts that declare
`frontmatter.nameField: 'external'`, and the launcher lets it win over the config.
Verified from a foreign project with `skill_prefix: false`:

```
SKILL_START_PROTO: 1
SKILL_PREFIX: true
```

Every other host keeps its template names and its rendered bytes byte-for-byte
(the assignment is emitted only for the external-name host), pinned by tests in
`test/gen-skill-docs.test.ts` and `test/gstack-skill-start.test.ts`.

---

## 4. What works from a foreign project (verified)

| capability | evidence |
|---|---|
| preamble + skill start | `SKILL_START_PROTO: 1` from `/tmp/dogfood-install` |
| `/gstack-review` preflight | base-branch fallback, 3-file diff, `review-log --start`, checklist at the runtime root |
| `/gstack-context-save` / `-restore` / `-learn` | state in `~/.gstack/projects/<origin-slug>/checkpoints/`; restore found it; learnings search returned the entry |
| `/gstack-freeze` + `/gstack-unfreeze` | 8/8 gate cases incl. a RELATIVE path, fail-closed with no session cwd, `..` escape, prefix collision. Enforced live: an out-of-boundary `write` was denied in-session |
| `/gstack-browse` (no Aside) | `load-html`, `console`, `text`, `screenshot` (12.7 KB PNG) |
| `gstack-render` | `ENGINE=browse`, screenshot of local HTML (14.2 KB) |
| `/gstack-diagram` | full triplet: `.svg` 13.6 KB, `.png` 28.5 KB, `.excalidraw` 5.3 KB |
| `/gstack-careful` | marker round-trips into the plugin risk gate (`MODE=careful`) |
| `/gstack-make-pdf` | fixed in this pass (section 5) |

Fresh machine (no `~/.dsh/skills/gstack`): the preamble degrades safely. It prints
`SKILL_START: unavailable — stale install; run ./setup or /gstack-upgrade` and
exits 0. Nothing loads, which is honest for a machine with no install.

---

## 5. Fixed in this pass

| finding | fix | files |
|---|---|---|
| `/gstack-make-pdf` printed `MAKE_PDF_NOT_AVAILABLE (P='/pdf')` in every project but the checkout — `$GSTACK_MAKE_PDF` was never defined and `make-pdf` was not linked | preamble emits `GSTACK_MAKE_PDF="$GSTACK_ROOT/make-pdf/dist"`; `make-pdf` added to both asset lists | `scripts/resolvers/preamble/generate-preamble-bash.ts`, `setup`, `hosts/dsh.ts` |
| `/gstack-upgrade` classified the install `vendored-global` and would clone the **upstream** repo (no dsh host) over it | dsh-only `{{DSH_UPGRADE_GUARD}}` detects the symlink farm, prints the real checkout path, and tells the model to skip Step 4 | `scripts/resolvers/dsh-upgrade-guard.ts`, `gstack-upgrade/SKILL.md.tmpl` |
| the preamble advised bare `/ship` in every project while dsh registers only `gstack-ship` — the config `skill_prefix` was echoed without the host's external-name rule | the render passes `GSTACK_SKILLS_PREFIXED=true` for `nameField: 'external'` hosts; the launcher lets it win over the config | `scripts/resolvers/preamble/generate-preamble-bash.ts`, `bin/gstack-skill-start` |

All three are covered by tests. The two `codex`/`factory` ship goldens were
refreshed for the one-line `GSTACK_MAKE_PDF` preamble addition; the
`GSTACK_SKILLS_PREFIXED` line is emitted only for the external-name host, so no
other host's bytes moved.

---

## 6. Known gaps that are not fixed

- **`setup --host dsh` from a foreign project installs nothing into it.** It prints
  `project skills: <checkout>/.dsh/skills`, which reads as "installed here". The
  install is user-scoped by design; only the message is misleading. P2.
- **gbrain memory from a foreign project writes into the gstack-dsh code mirror.**
  `remember` without `source_id` binds to `gstack-code-gstack-dsh-mirror`; an
  explicit `source_id: "default"` returns `scope_denied`. A foreign project needs
  its own symlink-free mirror source (the `~/.gbrain/code-mirrors/gstack-dsh-git`
  recipe). P1.
- **`/gstack-ship` cannot be dry-walked.** Every gate is prose plus real
  `git`/`gh` commands; the push site is unconditional. P2.
- **A cookie-imported browse daemon blocks local-HTML renders.** Fix is `$B stop`;
  the error says so. P3.
- **Agent Teams teammates could not execute a turn** in the session that ran these
  lanes; all four lanes were run by the Lead. Harness-side. P1.
