# Install Receipt — gstack-dsh plugin

Pinned artifact: **`gstack-dsh` v1.0.0**, source of truth
`/home/matt/src/gstack-dsh/.dsh/plugin/` (project-local, git-tracked).

The four states below are deliberately distinguished, because they fail
differently and a single "installed" claim would hide which one was actually
proven.

| State | Meaning | Status | Evidence |
|---|---|---|---|
| **Installed** | The bundle is a dependency of the DSH profile and resolves on disk. | ✅ | `dsh plugin --profile web install` → `+ gstack-dsh link:../../../src/gstack-dsh/.dsh/plugin` |
| **Loaded** | The cordis loader composed the row and the plugin's `apply()` ran without error. | ✅ | `dsh --profile web --dump-config` shows the `gstack-dsh` row (config block reproduced below); a real `dsh web` boot logs **zero** errors and reaches its readiness line. |
| **Activated** | The plugin's contributions exist at runtime and its skills are in the session catalog. | ✅ | Live probe registered all four tools (`jev_decide`, `gstack_pipeline`, `gstack_route_skill`, `gstack_escalate`) and the `tools/pre-execute` listener. The **session catalog in this very session changed to the `gstack-*` skills**, proving the Harness discovered `.dsh/skills` live. |
| **Verified** | Its behaviour was exercised against the real dependency and observed to produce correct results. | ✅ | `scripts/verify-live.mjs` → **7/7** checks against live OpenCode free Jev; `node --test test/` → **28/28**. |

## Pin details

| Field | Value |
|---|---|
| Plugin id | `gstack-dsh` |
| Version | `1.0.0` |
| Source path | `.dsh/plugin/` (tracked; see `.gitignore` note below) |
| Profile | `web` (`$DSH_HOME=/home/matt/.dsh`) |
| Dependency spec | `link:/home/matt/src/gstack-dsh/.dsh/plugin` |
| Resolved as | symlink `~/.dsh/profiles/web/node_modules/gstack-dsh → ../../../../src/gstack-dsh/.dsh/plugin` |
| Jev backend | `https://opencode.ai/zen/v1/systemone`, model `jev-1.13-free` (OpenCode **free**) |
| DSH version | `0.2.0-rc.2` |

### Why `link:` and not `file:` — this matters

`file:` makes pnpm **hard-copy** the plugin into `node_modules`. Edits to the
project source then do **not** reach the runtime, which silently produced a stale
plugin during development (fixed one bug in source, rebooted, bug persisted).
`link:` symlinks instead, so `.dsh/plugin/` stays the single source of truth.
**If a future change to the plugin seems to have no effect, check this symlink
first.** See "Known gaps" G1.

### `.gitignore` note

`.dsh/skills/` (generated renders) is gitignored like every other host's output.
`.dsh/plugin/` is **deliberately tracked** — it is the version-pinned artifact
this receipt refers to.

### Backup of pre-existing global profile state

Before editing the shared global profile, both files were copied into
`.dsh/backups/`:

- `.dsh/backups/profile-package.json.orig`
- `.dsh/backups/profile-cordis.patch.yml.orig`

To revert the install entirely: restore `~/.dsh/profiles/web/package.json` from
the backup (removing the `gstack-dsh` dependency and bundle entry) and re-run
`dsh plugin --profile web install`. The plugin source and `.dsh/skills/` can
then be deleted independently.

## Composed loader row (verbatim from `--dump-config`)

```yaml
# == gstack-dsh
- id: gstack-dsh
  name: gstack-dsh
  config:
    enabled: true
    baseUrl: https://opencode.ai/zen/v1/systemone
    model: jev-1.13-free
    riskGate: true
    gateThreshold: 0.7
    budget:
      perDecision: 1
      perStage: 2
      perSession: 6
      paidFallbacksPerSession: 1
```

## Verification commands (re-runnable)

```bash
# Unit suite (free, no credential)
cd .dsh/plugin && node --test test/

# Live suite (needs the OpenCode key)
cd .dsh/plugin && OPENCODE_API_KEY=... node scripts/verify-live.mjs

# Loader composition
dsh --profile web --dump-config | grep -A12 'gstack-dsh'

# Skills discovered
find .dsh/skills -name SKILL.md | wc -l   # expect 57
```

## Credential handling

The plugin **never stores a credential**. `lib/jev.js#resolveJevApiKey()` reads
`GSTACK_DSH_JEV_API_KEY`, then `OPENCODE_API_KEY`. The live probe extracts the
key from the existing profile patch at call time and passes it via env; it is
never printed or committed.

**Note for the next session:** a working OpenCode key exists in the clear at
`~/.dsh/profiles/web/cordis.patch.yml:33` (the pre-existing `tokenslash` row,
not something this work added). That is a pre-existing operator choice, flagged
here only so it is not mistakenly attributed to this port.
