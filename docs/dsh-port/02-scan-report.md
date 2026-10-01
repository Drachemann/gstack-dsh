# 02 — `repo_setup_scan` Report

Tool: `repo_setup_scan` (from the installed `dsh-repo-setup` plugin, v0.1.5 — itself a DSH plugin
that contributes the read-only `repo_setup_scan` tool).
Target: `/home/matt/src/gstack-dsh`.
Read-only: the scan modified nothing.

---

## Full report, verbatim

```markdown
# Repo setup scan: `/home/matt/src/gstack-dsh`

**Detected stack:** Node.js, JS test runner detected

## Repo hygiene
- ✅ `AGENTS.md` / `CLAUDE.md` present.
- ✅ Git repository initialized.
- ✅ GitHub Actions directory present.
- ✅ Test setup detected.

## Recommended installs
- `dsh plugin --profile web add mattpocock-skills-dsh`
- `dsh plugin --profile web add superpowers-dsh`
- `dsh plugin --profile web add dsh-ponytail-skills`
- `dsh plugin --profile web add dsh-ecc-skills`  (ECC skills, 273 curated)
- `dsh plugin --profile web add mattpocock-skills-dsh-zh`  (中文技能版,二选一 with the English pack)
- `dsh plugin --profile web add github:Bleed00/dsh-claude-mem`  (optional: cross-session memory)
- `dsh plugin --profile web add github:Nichts0v0/dsh-mcp-manager`  (to mount the MCP servers below)

**MCP servers to mount** (via the DSH MCP manager / Settings → MCP):
- `context7` (https://mcp.context7.com/mcp) — up-to-date library docs, kills hallucinated APIs
- `github` (official GitHub MCP via GitRuozhi/dsh-github-mcp) — issues/PRs in context

## Notes
- This scan is read-only: it never modified the repository.
- Re-run `repo_setup_scan` after the repo changes to refresh recommendations.
- Full plugin index: https://github.com/Dominic789654/awesome-deepseek-harness
```

---

## How this report is used as the factual basis

The scan supplies **four** facts about the surrounding environment. The port treats them as
constraints, and each is reconciled explicitly rather than assumed.

### Fact 1 — "Detected stack: Node.js, JS test runner detected"

Corroborated independently: `package.json` (Bun-backed per `CLAUDE.md`), `bunfig.toml`,
`test-setup.ts`, and a `test/` tree with hundreds of files. The scan's phrase "JS test runner"
understates it — gstack runs a **strict sharded free suite** (`bun run test`), a paid
diff-selected eval tier (`bun run test:evals`), and separate gate/periodic tiers.
Relevant consequence: the DSH host addition has a **pre-existing, non-trivial test surface**
that will notice a new host (see `01-…` C3). Validation for this port reuses that harness rather
than inventing a parallel one.

### Fact 2 — "Repo hygiene: AGENTS.md/CLAUDE.md present, git initialized, GitHub Actions present, test setup detected"

All four confirmed. Two are load-bearing for the port:

- **`AGENTS.md` present** — this is DSH's own instruction-file convention, and it is also gstack's
  AGENTS.md-host convention (`hosts/hermes.ts`, `hosts/openclaw.ts` both rewrite
  `CLAUDE.md` → `AGENTS.md`). So the port's `CLAUDE.md` → `AGENTS.md` path rewrite is not a
  guess; it matches both sides.
- **`.github/` present** — gstack's CI is extensive, so the port must keep the free suite green
  rather than adding a plugin that only works locally.

### Fact 3 — "Recommended installs"

The scan recommends seven skill/memory/manager plugins for this repo. **None of them are
installed, and the port does not install them.** They are recorded as environmental context and
as an explicit non-goal:

| Recommendation | Bearing on this port |
|---|---|
| `mattpocock-skills-dsh`, `superpowers-dsh`, `dsh-ponytail-skills`, `dsh-ecc-skills`, `mattpocock-skills-dsh-zh` | Third-party skill packs. Installing any would **collide with full gstack skill parity** by adding unrelated skills to the same catalog and consuming the catalog description budget. Deliberately not installed. |
| `dsh-claude-mem` (optional cross-session memory) | Overlaps gstack's own `context-save`/`context-restore`/`decision-search` state model. gstack already ships that capability; adding a second memory system would create two sources of truth. Not installed. |
| `dsh-mcp-manager` | Only needed to mount the two MCP servers below. See Fact 4. |

### Fact 4 — "MCP servers to mount: `context7` and `github`"

The port does **not** mount either, and this is a deliberate, evidence-backed decision:

- **`github`** — gstack already has first-class GitHub integration via the `gh` CLI (`/ship`
  creates PRs, `/review` triages comments, `/land-and-deploy` lands). Adding the GitHub MCP
  would duplicate that surface and add tool-schema tokens to every request.
- **`context7`** — useful for library-API lookup, but it is a *global* convenience unrelated to
  gstack's methodology. It is orthogonal to this port; mounting it would not serve any gstack
  workflow stage.

Both remain available to the user as follow-ups. The `repo_setup_scan` tool itself stays wired —
it is already installed via the `dsh-repo-setup` bundle and needs no action.

### Environment facts the scan does not cover (established independently)

The scan reports on the repository; it cannot see the DSH runtime. These were verified directly
and are needed for the build:

| Fact | Evidence |
|---|---|
| Active profile is `web`; `DSH_HOME=/home/matt/.dsh` | `$DSH_PROFILE`, `$DSH_HOME` |
| DSH version `0.2.0-rc.2` | `dsh --version` |
| DSH discovers project skills at `{projectRoot}/.dsh/skills` | `@deepseek-ai/dsh-skill-filesystem` `roots()` — `join(projectRoot, ".dsh/skills")`, source `project-dsh` |
| User skills come from `$DSH_HOME/skills`; project roots **rank ahead** of user roots | same `roots()`; `PROJECT_DSH_RANK` < `USER_DSH_RANK` |
| Session default model is `deepseek-official` / `deepseek-flash`, `reasoningEffort: high` | composed config row `agent-default-model`; also `profile/cordis.patch.yml:13-18` |
| Jev is already bound to OpenCode free | `profile/cordis.patch.yml:28-36` (`tokenslash`: provider `opencode`, `https://opencode.ai/zen/v1/systemone`, model `jev-1.13-free`) |
| The Jev binding **works** | live probe → HTTP 200, `{"model":"jev-1.13-free","answers":{"ping":{"type":"noul","noul":0.6}},"usage":{…}}` |
| `deepseek-v4-pro` is present in the live global profile | `profile/cordis.patch.yml:441,447`; `dsh-tokenslash/lib/shared/constants.js:66` — conflicts with the requirement that it appear nowhere (flagged in `03-…`) |
