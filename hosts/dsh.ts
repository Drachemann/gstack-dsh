import { defineHost } from './define-host';

/**
 * DeepSeek Harness (dsh).
 *
 * Discovery: the Harness's own filesystem skill provider scans
 * `{projectRoot}/.dsh/skills` as its highest-ranked project root (source
 * `project-dsh`, ahead of `project-agents`, and ahead of the `user-dsh` root at
 * `<dshHome>/skills` = `~/.dsh/skills` at rank 400). It watches those roots
 * live, and it resolves exactly one level deep — `<root>/<name>/SKILL.md` or
 * `<root>/<name>.md`. Nested `SKILL.md` files are deliberately NOT discovered.
 *
 * That last property is what makes this host installable: one directory
 * (`.dsh/skills/gstack/`, or `~/.dsh/skills/gstack/` for a global install) can
 * hold the rendered router skill at depth 1 *and* the runtime assets every
 * skill references through `$GSTACK_ROOT` without a single nested skill being
 * double-discovered. `./setup --host dsh` builds that directory by rendering
 * the skill tree and symlinking the assets in `runtimeRoot.globalSymlinks`;
 * rendering alone is NOT an install, because a rendered tree with no assets
 * leaves every `$GSTACK_ROOT/bin/*` call in every skill failing.
 *
 * Paths: the derived `hostSubdir`/`localSkillRoot` defaults (`.dsh` and
 * `.dsh/skills/gstack`) already land on the discovery root. `globalRoot` is
 * stated explicitly for the same value so `host-config-export.ts symlinks`
 * and the setup installer agree on `~/.dsh/skills/gstack` as the global root.
 *
 * Frontmatter: dsh reads `name`, `description`, `whenToUse`,
 * `disable-model-invocation`, and `user-invocable` (see
 * `@deepseek-ai/dsh-skill-filesystem` `parseSkillFile` / `parseInvocationPolicy`;
 * the legacy keys `modelInvocable`, `userInvocable`, and `disableModelInvocation`
 * are explicitly REJECTED, so they must never be emitted). gstack's own
 * `triggers` list therefore has to be renamed to `whenToUse` or it is silently
 * dropped, and `preamble-tier` / `version` / `allowed-tools` are dropped because
 * dsh has no per-skill tool allowlist at all — `allowed-tools` enforcement is a
 * documented capability LOSS on this host, not a translation.
 */
const dsh = defineHost({
  name: 'dsh',
  displayName: 'DeepSeek Harness',
  cliCommand: 'dsh',
  cliAliases: ['deepseek-harness'],

  // The DeepSeek family is registered in scripts/models.ts; the overlay lives at
  // model-overlays/deepseek.md. Host !== model: this only chooses which
  // behavioural overlay is rendered, never which model executes — execution is
  // owned by the Harness (`agent-default-model`, `llm-pi-ai`).
  defaultModel: 'deepseek',

  globalRoot: '.dsh/skills/gstack',
  localSkillRoot: '.dsh/skills/gstack',
  hostSubdir: '.dsh',

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: null,
    // dsh's registry keys skills by the frontmatter `name` (it validates and
    // de-duplicates on it) and its `/name` gesture matches that same value, so
    // the field must carry the host's external name (`gstack-ship`) rather than
    // the template's bare name (`ship`). Without this, every generated skill
    // would collide with a same-named skill from any other installed pack.
    nameField: 'external',
    // `triggers` -> `whenToUse` is the only gstack key dsh has a real home for.
    renameFields: {
      triggers: 'whenToUse',
    },
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '$GSTACK_ROOT' },
    { from: '.claude/skills/gstack', to: '.dsh/skills/gstack' },
    { from: '.claude/skills', to: '.dsh/skills' },
    { from: '~/.claude/skills', to: '.dsh/skills' },
    // dsh reads AGENTS.md, not CLAUDE.md.
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],

  toolRewrites: {
    // Plan mode is a dsh tool too, but under its own name. `ExitPlanMode` is the
    // single highest-volume Claude-only *tool* name in the corpus (122 hits
    // across 50 skills) and the plan-mode gate in /gstack-ship blocks on it, so
    // it is a hard break rather than a cosmetic leak.
    'ExitPlanMode': 'exit_plan_mode',
    // dsh's `subagent` has description/prompt/run_in_background/provider/model/
    // reasoning_effort. It has NO `subagent_type`, so every dispatch site that
    // spells one out would be rejected on this host.
    '`subagent_type: "general-purpose"`': 'a self-contained `prompt`',
    '`subagent_type: "Plan"`': 'a self-contained `prompt`',
    // Foreground-vs-background guidance is real on dsh (`subagent` also defaults
    // to background), but the version it cites is Claude Code's.
    'since Claude Code v2.1.198': 'in this harness',
    // AskUserQuestion is the highest-volume Claude-ism in the corpus (269 hits)
    // and was never in any existing rewrite table.
    'AskUserQuestion': 'ask_user_question',
    'use the Bash tool': 'use the bash tool',
    'use the Write tool': 'use the write tool',
    'use the Read tool': 'use the read tool',
    'use the Edit tool': 'use the edit tool',
    'use the Agent tool': 'use the subagent tool',
    // Bare "Agent" spellings the `the Agent tool` rewrite above does not reach.
    // They are the residue a render-level grep finds after the table runs, and
    // leaving them means a skill tells the model to make calls it cannot make.
    'Agent tool calls': '`subagent` calls',
    'Agent subagents': '`subagent` calls',
    'using Agent,': 'using the `subagent` tool,',
    'through Agent with': 'through the `subagent` tool with',
    // NOT `via the Agent`: the pre-existing `the Agent tool` entry below already
    // covers "via the Agent tool", and shadowing it here produced
    // "via the `subagent` tool tool".
    'on the Agent call': 'on the `subagent` call',
    'Agent/Task fallback': '`subagent` fallback',
    "the Agent's tool definition": "the `subagent` tool's schema",
    "Read Agent's tool definition": "Read the `subagent` tool's schema",
    'Agent tool, `run_in_background: false`': '`subagent` tool, `run_in_background: false`',
    'dispatch one read-only Agent': 'dispatch one read-only subagent',
    'Use the Agent': 'Use the `subagent`',
    'the Agent prompt': 'the `subagent` prompt',
    'the native Agent its': 'the native subagent its',
    'use the Grep tool': 'use the grep tool',
    'use the Glob tool': 'use the glob tool',
    'the Bash tool': 'the bash tool',
    'the Read tool': 'the read tool',
    'the Write tool': 'the write tool',
    'the Edit tool': 'the edit tool',
    'the Agent tool': 'the subagent tool',
    'the Skill tool': 'the skill tool',
    'use the WebSearch tool': 'use the web_search tool',
    'the WebSearch tool': 'the web_search tool',
  },

  // dsh has no Claude Code / Codex CLI to shell out to, so the two resolvers
  // that exist only to compose a Codex invocation are suppressed. Everything
  // else in CROSS_MODEL_RESOLVERS is deliberately KEPT:
  //
  //   REVIEW_ARMY      — dispatches parallel specialist *subagents*; dsh has a
  //                      native `subagent` tool, so this is exactly the fan-out
  //                      dsh is good at. The first port suppressed it by
  //                      reading "cross-model" as "cross-harness".
  //   ADVERSARIAL_STEP — a native in-host adversarial subagent plus an optional
  //                      Codex pass. Suppressing the resolver dropped the native
  //                      pass too.
  //   DESIGN_OUTSIDE_VOICES — same shape: native subagent review plus an
  //                      optional Codex second opinion.
  //
  // GBrain stays un-suppressed, mirroring hermes: the brain resolvers degrade to
  // "proceed without brain context" when no brain is configured, and become live
  // the moment `setup-gbrain` has put one behind the MCP layer. Suppressing them
  // here would mean a dsh user who completes the gbrain setup still gets zero
  // brain-aware skills, because suppression is decided at render time.
  suppressedResolvers: ['CODEX_SECOND_OPINION', 'CODEX_PLAN_REVIEW'],

  // A project-local install is preferred only when it is provably usable. dsh
  // renders its skills into `.dsh/skills` — the same path `localSkillRoot`
  // points at — so the directory always exists after a render while the runtime
  // assets it needs may not. Without this probe, `$GSTACK_ROOT` in every
  // rendered skill resolves to that half-populated directory and every `bin/*`
  // call fails, even with a healthy global install present.
  localSkillRootProbe: 'bin/gstack-skill-start',

  // The global runtime root is a symlink farm of the source checkout. dsh's
  // skill provider scans exactly one level deep (`<root>/<name>/SKILL.md`), so
  // nested trees are never discovered as skills and one directory can hold the
  // rendered router skill *and* every asset path the skills reference.
  //
  // The list is the observed asset set across the rendered dsh corpus, gathered
  // from BOTH reference forms — `$GSTACK_ROOT/<path>` and the literal
  // `$HOME/.dsh/skills/gstack/<path>` that the path rewrites produce when the
  // source text spelled `$HOME/.claude/...` instead of `~/.claude/...`. The
  // second form bypasses `$GSTACK_ROOT` entirely (and the project-local
  // override with it), which is how `freeze` and `extension` were missed on the
  // first pass and `/unfreeze` failed with exit 127.
  //
  // One deliberately absent entry: `.git` (gstack-upgrade probes for it, but its
  // `elif` chain is written for a non-git runtime root — linking the source
  // checkout's `.git` in would let an upgrade mutate the plugin's own git
  // state). `careful` is NOT one of these. It was previously left out on the
  // reasoning that its assets are reached only from frontmatter hooks, which
  // dsh drops — but `careful/bin/hook-extract.sh` is also the shared JSON helper
  // `freeze/bin` sources at runtime, and `/gstack-freeze` calls
  // `freeze/bin/freeze-state.sh` directly (not through a hook). That script
  // sources `../../careful/bin/hook-extract.sh` under `set -euo pipefail`, so a
  // copy-based install breaks /gstack-freeze, /gstack-unfreeze and /gstack-guard.
  // A symlink install only appeared to work because `..` resolved back through
  // the `freeze` symlink into the checkout.
  runtimeRoot: {
    globalSymlinks: [
      'bin',
      'lib',
      'browse',
      'design',
      // `make-pdf` is the third engine, and the only one whose resolver reads an
      // env-var path ($GSTACK_MAKE_PDF) rather than the project-local render
      // tree. It was omitted here, so `/gstack-make-pdf` printed
      // MAKE_PDF_NOT_AVAILABLE on every project except the source checkout.
      'make-pdf',
      'docs',
      'scripts',
      'review',
      'ship',
      'plan-eng-review',
      'plan-design-review',
      'plan-devex-review',
      'design-html',
      'office-hours',
      'gstack-upgrade',
      'supabase',
      'freeze',
      // Not hook-only: the shared JSON extractor `freeze/bin/*` sources at
      // runtime (see the header note above). Omitted, `/gstack-freeze` dies on a
      // copy-based install.
      'careful',
      'extension',
      'VERSION',
      'ETHOS.md',
    ],
  },

  install: {
    linkingStrategy: 'symlink-generated',
  },

  coAuthorTrailer: 'Co-Authored-By: DeepSeek Harness <noreply@deepseek.com>',
});

export default dsh;
