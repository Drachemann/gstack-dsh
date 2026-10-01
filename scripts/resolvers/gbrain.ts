/**
 * GBrain resolver — brain-first lookup and save-to-brain for thinking skills.
 *
 * GBrain is a "mod" for gstack. When installed, coding skills become brain-aware:
 * they search the brain for context before starting and save results after finishing.
 *
 * These resolvers are suppressed on hosts that don't support brain features
 * (via suppressedResolvers in each host config). For those hosts,
 * {{GBRAIN_CONTEXT_LOAD}}, {{GBRAIN_SAVE_RESULTS}}, {{BRAIN_PREFLIGHT}},
 * {{BRAIN_CACHE_REFRESH}}, and {{BRAIN_WRITE_BACK}} all resolve to empty string.
 *
 * Compatible with GBrain >= v0.10.0 (search CLI, doctor --fast --json, entity enrichment).
 *
 * Brain-aware planning (T4 / v1.48 plan): adds three new resolvers powered by
 * the bin/gstack-brain-cache CLI and scripts/brain-cache-spec.ts. The new
 * resolvers fire only for the 5 planning skills registered in
 * SKILL_DIGEST_SUBSETS (office-hours, plan-ceo-review, plan-eng-review,
 * plan-design-review, plan-devex-review).
 */
import type { TemplateContext } from './types';
import {
  SKILL_DIGEST_SUBSETS,
  SKILL_CALIBRATION_WEIGHTS,
  BRAIN_CACHE_ENTITIES,
  getSkillSubset,
  getInvalidationTargets,
} from '../brain-cache-spec';

// Per-skill slug + title + tag metadata for SAVE_RESULTS. The full save
// template (heredoc body, entity-stub instructions, throttle handling,
// backlinks) lives in docs/gbrain-write-surfaces.md §Save Template and is
// read on-demand by the agent. Compressing the inline prose keeps the
// token footprint at ~150 tokens per skill (down from ~500), so users with
// gbrain installed pay a small overhead and users without it (whose hosts
// have GBRAIN_SAVE_RESULTS suppressed at gen-time) pay nothing.
interface SkillSaveMeta {
  slugPrefix: string;
  title: string;
  tag: string;
}

const skillSaveMap: Record<string, SkillSaveMeta> = {
  'office-hours':         { slugPrefix: 'office-hours',    title: 'Office Hours',    tag: 'design-doc' },
  'investigate':          { slugPrefix: 'investigations',  title: 'Investigation',   tag: 'investigation' },
  'plan-ceo-review':      { slugPrefix: 'ceo-plans',       title: 'CEO Plan',        tag: 'ceo-plan' },
  'plan-eng-review':      { slugPrefix: 'eng-reviews',     title: 'Eng Review',      tag: 'eng-review' },
  'plan-design-review':   { slugPrefix: 'design-reviews',  title: 'Design Review',   tag: 'design-review' },
  'plan-devex-review':    { slugPrefix: 'devex-reviews',   title: 'Devex Review',    tag: 'devex-review' },
  'retro':                { slugPrefix: 'retros',          title: 'Retro',           tag: 'retro' },
  'ship':                 { slugPrefix: 'releases',        title: 'Release',         tag: 'release' },
  'cso':                  { slugPrefix: 'security-audits', title: 'Security Audit',  tag: 'security-audit' },
  'design-consultation':  { slugPrefix: 'design-systems',  title: 'Design System',   tag: 'design-system' },
};

export function generateGBrainContextLoad(ctx: TemplateContext): string {
  let base = `## Brain Context Load

**Skip this entire section if \`gbrain\` is not on PATH.**

Extract 2-4 keywords from the user's request. Search the brain:
\`gbrain search "<keywords>"\`. Read the top 3 results with
\`gbrain get_page "<slug>"\`. Use that context to inform your analysis.

If \`gbrain search\` returns no results or any non-zero exit, proceed
without brain context. Full search/read protocol + examples:
see \`docs/gbrain-write-surfaces.md\` §Context Load.`;

  if (ctx.skillName === 'investigate') {
    base += `\n\nFor structured-data extraction requests ("track this", "extract from emails", "build a tracker"), route to GBrain's data-research skill instead: \`gbrain call data-research\`.`;
  }

  return base;
}

export function generateGBrainSaveResults(ctx: TemplateContext): string {
  // gbrain v0.18+ uses `gbrain put <slug>` (NOT the deprecated `put_page`
  // MCP op). Compressed in v1.50.0.0: the inline heredoc + entity-stub +
  // throttle + backlink prose moved to docs/gbrain-write-surfaces.md
  // §Save Template, which the agent reads on demand when it actually
  // saves. The compact pointer keeps non-gbrain users' token overhead
  // near zero when their host's static suppression is overridden by
  // detection.
  const meta = skillSaveMap[ctx.skillName];

  if (!meta) {
    return `## Save Results to Brain

**Skip this entire section if \`gbrain\` is not on PATH.**

If the skill output is worth preserving, save it via
\`gbrain put "<slug>" --content "<frontmatter + markdown>"\`. On a machine with
more than one source, pass \`--source-id <id>\` — gbrain defaults to its selected
source, which on a synced repo is that repo's code mirror, not your memory
source. Full template (heredoc body, frontmatter shape, entity-stub
instructions, throttle handling): see \`docs/gbrain-write-surfaces.md\` §Save Template.`;
  }

  return `## Save Results to Brain

**Skip this entire section if \`gbrain\` is not on PATH.**

After completing this skill, save the output:

\`\`\`bash
# Route to the configured memory source when one is set. Without this, gbrain
# writes to its "selected source", which on a synced repo is the repo's code
# mirror — durable memory then lands in code pages. Unset keeps gbrain's own
# routing, so this is a no-op by default. The id is a short source name (no
# spaces), so the unquoted expansion below is deliberate.
_GB_SRC=$(${ctx.paths.binDir}/gstack-config get gbrain_memory_source 2>/dev/null)
[ -n "$_GB_SRC" ] && _GB_SRC="--source-id $_GB_SRC"
gbrain put "${meta.slugPrefix}/<feature-slug>" $_GB_SRC --content "$(cat <<'EOF'
---
title: "${meta.title}: <feature name>"
tags: [${meta.tag}, <feature-slug>]
---
<skill output in markdown>
EOF
)"
\`\`\`

Then extract person/org entities and create stub pages for each one.
Throttle errors (exit 1 with "throttle"/"rate limit"/"busy") and any
other non-zero exit are transient — don't retry inline. Full entity-stub
template, throttle handling, and backlink protocol:
see \`docs/gbrain-write-surfaces.md\` §Save Template.`;
}

// ────────────────────────────────────────────────────────────────────
// Brain-aware planning resolvers (T4 / v1.48 plan)
// ────────────────────────────────────────────────────────────────────

/**
 * Returns true when this skill is registered for brain preflight. Skills not
 * in SKILL_DIGEST_SUBSETS get an empty BRAIN_PREFLIGHT block (no behavior).
 */
function isPreflightSkill(skillName: string): boolean {
  return Object.prototype.hasOwnProperty.call(SKILL_DIGEST_SUBSETS, skillName);
}

/**
 * Renders the per-skill BRAIN_PREFLIGHT block. The rendered output is a single
 * bash script that:
 *   1. Reads each digest file from gstack-brain-cache get (one call per digest)
 *   2. Falls back to "(brain context unavailable)" on missing
 *   3. Concatenates outputs into a single ## Brain Context block injected
 *      into the skill's prompt context
 *   4. Tells the agent: "use this context to skip already-known questions"
 *
 * The cache CLI handles cold-refresh + lock dedup + stale-but-usable
 * fallback internally. From the resolver's perspective the call is one
 * shell command per digest.
 */
export function generateBrainPreflight(ctx: TemplateContext): string {
  if (!isPreflightSkill(ctx.skillName)) return '';
  const subset = getSkillSubset(ctx.skillName);
  const binDir = ctx.paths.binDir;
  // Build the bash that loads each digest. Per-skill subset is small (2-5 entries).
  const loadLines = subset.map((entityName) => {
    const entity = BRAIN_CACHE_ENTITIES[entityName];
    if (!entity) return '';
    const projectFlag = entity.scope === 'per-project' ? '--project "$SLUG"' : '';
    return `  printf '\\n### %s\\n\\n' "${entityName}"\n  ${binDir}/gstack-brain-cache get ${entityName} ${projectFlag} 2>/dev/null || printf '_(no ${entityName} digest available yet)_\\n'`;
  }).join('\n');
  const usageByEntity: Record<string, string> = {
    product: 'If `product` digest names the value prop, target user, or stage, do not re-ask.',
    goals: 'If `goals` digest lists active goals, frame recommendations against them.',
    'recent-decisions': 'If `recent-decisions` digest names a prior scope/architecture choice, flag if this plan contradicts.',
    'user-profile': 'If `user-profile` digest carries calibration pattern statements ("tends to over-engineer security"), surface them when relevant.',
    'developer-persona': 'If `developer-persona` digest describes the builder workflow or friction tolerance, adapt the DX recommendations.',
    brand: 'If `brand` digest names visual principles or constraints, use them before asking about design taste.',
    'competitive-intel': 'If `competitive-intel` digest names peer products or workflow expectations, use them as comparison context.',
    salience: 'If `salience` digest surfaces recent local context, treat it as a pointer to verify rather than a standalone fact.',
  };
  const usageLines = subset
    .map((entityName) => usageByEntity[entityName])
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join('\n');

  return `## Brain Context (preflight)

${ctx.skillName === 'plan-eng-review' ? 'After the Scope gate, before later review questions, load the brain\'s structured context' : 'Before asking any clarifying questions, load the brain\'s structured context'}
for this project. The cache layer handles staleness, refresh, and stale-but-
usable fallback automatically. Skip questions whose answers are already
present in the loaded context; ground recommendations in what the brain
prints for this skill.

\`\`\`bash
eval "$(${binDir}/gstack-slug 2>/dev/null)" 2>/dev/null || true
{
  printf '## Brain Context\\n\\n'
${loadLines}
} > /tmp/.gstack-brain-context-$$.md 2>/dev/null
[ -s /tmp/.gstack-brain-context-$$.md ] && cat /tmp/.gstack-brain-context-$$.md
rm -f /tmp/.gstack-brain-context-$$.md 2>/dev/null || true
\`\`\`

**How to use this context:**
${usageLines}
- If a digest is \`(no X digest available yet)\`, treat that section as cold; ask the user.

**Privacy:** Salience digest is filtered by allowlist (D9 default: \`projects/\`,
\`gstack/\`, \`concepts/\` only). Personal/family/therapy content never leaks here.
`;
}

/**
 * Renders the at-skill-end background refresh hook. Fires after the skill's
 * own work completes (telemetry has already logged); kicks any digest whose
 * age exceeds half its TTL but hasn't yet expired, so the NEXT invocation
 * gets a fresh cache without paying the cold-miss tax.
 *
 * Subordinate to {{TELEMETRY}} — runs after. Doesn't block the user.
 */
export function generateBrainCacheRefresh(ctx: TemplateContext): string {
  if (!isPreflightSkill(ctx.skillName)) return '';
  const binDir = ctx.paths.binDir;
  return `## Brain Cache Background Refresh

${ctx.skillName === 'plan-ceo-review' ? `After the exit gate passes, start this nonblocking refresh before telemetry.
Then return to the finalization instructions below; the user need not wait for
the refresh process.` : `After the skill's work completes (and telemetry has logged), kick a
background refresh of any cache digest that's getting close to its TTL.
This is non-blocking — the user doesn't wait. Next invocation benefits
from the warm cache.`}

\`\`\`bash
eval "$(${binDir}/gstack-slug 2>/dev/null)" 2>/dev/null || true
(${binDir}/gstack-brain-cache refresh --project "$SLUG" 2>/dev/null &) || true
\`\`\`
`;
}

/**
 * Renders the calibration write-back block. ONLY emits when the skill makes
 * typed decisions worth a kind=bet take AND the brain trust policy is
 * personal. Phase 2 / E5 cross-skill calibration.
 *
 * Gated behind BRAIN_CALIBRATION_WRITEBACK feature flag in the resolver
 * output — the flag stays false until upstream gbrain ships takes_add MCP
 * op (T8). When the flag flips, the existing skill templates pick up the
 * write-back behavior without any template changes.
 */
export function generateBrainWriteBack(ctx: TemplateContext): string {
  if (!isPreflightSkill(ctx.skillName)) return '';
  const weight = SKILL_CALIBRATION_WEIGHTS[ctx.skillName];
  if (weight == null) return '';
  // List the cache digests this skill's writes should invalidate. Multiple
  // skills write to multiple entities; the invalidation map captures this.
  const invalidatesEntities = getInvalidationTargets(`/${ctx.skillName}`);
  const invalidateBash = invalidatesEntities
    .map((e) => `  ${ctx.paths.binDir}/gstack-brain-cache invalidate ${e} --project "$SLUG" 2>/dev/null || true`)
    .join('\n');

  return `## Brain Calibration Write-Back (gated)

${ctx.skillName === 'plan-eng-review' ? '`BRAIN_CALIBRATION_WRITEBACK` is a reserved default-off gate; this runtime does not set it. Skip this section and continue the finish sequence. Do not enable it or infer permission from brain availability. The contract below is retained for future gated integration, not an instruction to write now.\n\n' : ''}Skip unless \`BRAIN_CALIBRATION_WRITEBACK\` is set and the preamble/brain-health
output or gstack config shows \`brain_trust_policy@<endpoint-hash>=personal\`.
If unknown, skip. If both gates pass, record one durable
typed prediction with \`mcp__gbrain__takes_add\`; if unavailable, use
\`mcp__gbrain__put_page\` with a gstack:takes fence block.

Take frontmatter:
\`\`\`yaml
kind: bet
holder: <user identity from whoami>
claim: <one-line prediction the skill is making>
weight: ${weight}
since_date: <today's date>
expected_resolution: <date in 1-3 months depending on skill>
source_skill: ${ctx.skillName}
\`\`\`

After write, invalidate affected digests:

\`\`\`bash
eval "$(${ctx.paths.binDir}/gstack-slug 2>/dev/null)" 2>/dev/null || true
${invalidateBash || '  # (no per-skill invalidation targets configured)'}
\`\`\``;
}

/** How this host registers an MCP server, as a name the skill prose can use. */
function mcpHostLabel(host: string): string {
  switch (host) {
    case 'dsh':
      return 'dsh';
    case 'claude':
      return 'Claude Code';
    default:
      return host;
  }
}

/**
 * Step 5a of /setup-gbrain — register gbrain as an MCP server for the host the
 * skill was rendered for.
 *
 * Hosts differ in mechanism, not just in wording, so this is a resolver rather
 * than prose the model must adapt:
 *   - Claude Code has a real CLI verb (`claude mcp add`).
 *   - DeepSeek Harness has a watched config *layer*, not a CLI. Its `dsh-mcp`
 *     helper is unusable outside the DSH install tree (it fails to resolve its
 *     own peer dependency), so the correct registration is a direct, validated
 *     write to the user-scope JSON layer.
 *   - Every other host keeps the historical "register it in your own config"
 *     instruction.
 */
export function generateGBrainMcpRegister(ctx: TemplateContext): string {
  if (ctx.host === 'dsh') return generateDshMcpRegister();

  const label = mcpHostLabel(ctx.host);
  return `## Step 5a: Register gbrain as ${label} MCP (D18)

Only if \`which claude\` resolves. Ask: "Give ${label} a typed tool surface
for gbrain? (recommended yes)"

The registration form depends on the path picked in Step 2:

### Path 4 (Remote MCP — HTTP transport with bearer)

Tear down any prior registration (could be local-stdio from an old setup,
or stale remote-http with a rotated token), then register with HTTP +
bearer at user scope:

\`\`\`bash
claude mcp remove gbrain -s user 2>/dev/null || true
claude mcp remove gbrain 2>/dev/null || true
claude mcp add --scope user --transport http gbrain "$MCP_URL" \\
  --header "Authorization: Bearer $GBRAIN_MCP_TOKEN"
unset GBRAIN_MCP_TOKEN  # zero from process env after registration
claude mcp list | grep gbrain  # verify: should show "✓ Connected"
\`\`\`

**Token-storage note:** \`claude mcp add --header "Authorization: Bearer ..."\`
puts the bearer on argv during process startup, briefly visible to \`ps\` for
~10ms. The token's resting state is \`~/.claude.json\` (mode 0600 — Claude
Code's own credential surface for every MCP server). This trade-off is
documented in \`setup-gbrain/memory.md\`. If a future Claude Code release adds
a stdin or env-var input form for headers, switch to that.

### Paths 1, 2a, 2b, 3 (Local stdio)

Register at **user scope** with an **absolute path** to the gbrain
binary. User scope makes the MCP available in every Claude Code session on
this machine, not just the current workspace. Absolute path avoids PATH
resolution issues when Claude Code spawns \`gbrain serve\` as a subprocess.

\`\`\`bash
GBRAIN_BIN=$(command -v gbrain)
[ -z "$GBRAIN_BIN" ] && GBRAIN_BIN="$HOME/.bun/bin/gbrain"
claude mcp remove gbrain -s user 2>/dev/null || true
claude mcp remove gbrain 2>/dev/null || true
claude mcp add --scope user gbrain -- "$GBRAIN_BIN" serve
claude mcp list | grep gbrain  # verify: should show "✓ Connected"
\`\`\`

### Both paths

If \`claude\` is not on PATH: emit "MCP registration skipped — this skill is
Claude-Code-targeted; register \`gbrain serve\` (or your remote MCP URL) in
your agent's MCP config manually." Continue to step 6.

**Heads-up for the user:** an already-open Claude Code session will not
pick up the new MCP tools until restart. Tell them: "Restart any open
Claude Code sessions to see \`mcp__gbrain__*\` tools — they're loaded at
session start, not mid-session."`;
}

/**
 * The dsh registration block.
 *
 * Facts this block is built on, each verified against the installed plugin:
 *   - dsh mounts MCP servers from a *layered config*, and a live watcher
 *     hot-reloads it, so registration is a file write, not a CLI verb.
 *   - The `dsh-mcp` helper cannot run here: it loads the MCP client, whose
 *     `@deepseek-ai/dsh-scope` peer only resolves inside the DSH install tree,
 *     so `dsh-mcp` is not on PATH and `node lib/cli.js` aborts with
 *     ERR_MODULE_NOT_FOUND. Never shell out to it.
 *   - User-scope JSON lives at \`$DSH_HOME/mcp.json\` (default \`~/.dsh/mcp.json\`)
 *     and is read as \`{"mcpServers": {...}}\`.
 *   - \`${'${VAR}'}\` placeholders are kept literal on disk and expanded from the
 *     host environment at mount time, including inside \`headers\`, so a bearer
 *     token never has to rest in the file.
 *   - Shadowing is silent: a same-named entry in ANY higher layer
 *     (\`.dsh/mcp.yml\`, \`.dsh/mcp.json\`, legacy \`.mcp.json\`, a profile file, or
 *     \`~/.dsh/mcp.yml\`) drops this one with no error. Verification has to prove
 *     the entry survived, not just that it was written.
 */
function generateDshMcpRegister(): string {
  return `## Step 5a: Register gbrain as a dsh MCP server (D18)

Ask: "Give this dsh session a typed tool surface for gbrain? (recommended yes)"

dsh has **no \`mcp add\` verb**. It mounts MCP servers from a layered config that
a live watcher picks up, so registration is a validated write to
\`$DSH_HOME/mcp.json\` (default \`~/.dsh/mcp.json\`) — *user scope*, so every dsh
project on this machine sees the brain. Project scope would be
\`<projectRoot>/.dsh/mcp.json\`.

**Do NOT shell out to \`dsh-mcp\`.** It is not on PATH, and running its \`cli.js\`
directly aborts with \`ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-scope\`, because
that peer dependency only resolves inside the DSH install tree. Write the file.

Never hand-edit the JSON: a syntax error (comment, trailing comma) or a
non-object \`mcpServers\` discards the **entire layer** with no error at all.
The block below parses first and refuses to write anything it could not read.

### Path 4 (Remote MCP — HTTP transport with bearer)

The bearer is written as a \`\${GBRAIN_MCP_TOKEN}\` placeholder and expanded by
dsh at mount time from the host environment — the token stays in your shell
profile and never rests in the config file.

\`\`\`bash
DSH_MCP_JSON="\${DSH_HOME:-$HOME/.dsh}/mcp.json"
mkdir -p "$(dirname "$DSH_MCP_JSON")"
DSH_MCP_JSON="$DSH_MCP_JSON" GBRAIN_MCP_URL="$MCP_URL" node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const p = process.env.DSH_MCP_JSON;
let doc = {};
try {
  const raw = readFileSync(p, "utf8").trim();
  if (raw) doc = JSON.parse(raw);
} catch (err) {
  // A missing file is the ordinary FIRST registration, not a corrupt one:
  // start from an empty document instead of refusing to write. Only a genuine
  // read/parse failure is a reason to stop.
  if (err.code === "ENOENT") {
    doc = {};
  } else {
    console.error("refusing to overwrite " + p + " — it is not valid JSON: " + err.message);
    process.exit(1);
  }
}
if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
  console.error("refusing to overwrite " + p + " — top level must be a JSON object");
  process.exit(1);
}
const servers = (doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers)) ? doc.mcpServers : {};
servers.gbrain = {
  type: "http",
  url: process.env.GBRAIN_MCP_URL,
  headers: { Authorization: "Bearer \${GBRAIN_MCP_TOKEN}" }
};
doc.mcpServers = servers;
writeFileSync(p, JSON.stringify(doc, null, 2) + "\\n");
console.log("registered gbrain (http) in " + p);
'
\`\`\`

Export \`GBRAIN_MCP_TOKEN\` in your shell profile (not here, and not in the
config file) so dsh can expand it at mount time.

### Paths 1, 2a, 2b, 3 (Local stdio)

Absolute path, user scope. dsh spawns the server itself, so a bare \`gbrain\`
would depend on the PATH dsh inherited rather than the PATH you have now.

\`\`\`bash
DSH_MCP_JSON="\${DSH_HOME:-$HOME/.dsh}/mcp.json"
GBRAIN_BIN=$(command -v gbrain)
[ -z "$GBRAIN_BIN" ] && GBRAIN_BIN="$HOME/.bun/bin/gbrain"
# Set this to the embedding provider's env var from Step 4.0 — for example
# OPENROUTER_API_KEY, OPENAI_API_KEY or VOYAGE_API_KEY. Leave it EMPTY for a
# local provider (ollama, lmstudio) or an explicit keyless brain.
GBRAIN_KEY_VAR="\${GBRAIN_KEY_VAR:-}"
mkdir -p "$(dirname "$DSH_MCP_JSON")"
DSH_MCP_JSON="$DSH_MCP_JSON" GBRAIN_BIN="$GBRAIN_BIN" GBRAIN_KEY_VAR="$GBRAIN_KEY_VAR" node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const p = process.env.DSH_MCP_JSON;
let doc = {};
try {
  const raw = readFileSync(p, "utf8").trim();
  if (raw) doc = JSON.parse(raw);
} catch (err) {
  // A missing file is the ordinary FIRST registration, not a corrupt one:
  // start from an empty document instead of refusing to write. Only a genuine
  // read/parse failure is a reason to stop.
  if (err.code === "ENOENT") {
    doc = {};
  } else {
    console.error("refusing to overwrite " + p + " — it is not valid JSON: " + err.message);
    process.exit(1);
  }
}
if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
  console.error("refusing to overwrite " + p + " — top level must be a JSON object");
  process.exit(1);
}
const servers = (doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers)) ? doc.mcpServers : {};
// dsh does NOT hand its own environment to a stdio MCP server, so an API key
// visible in the dsh process is still invisible to the spawned gbrain server.
// The brain then degrades SILENTLY: vector search falls back to keyword-only
// and the chat/expansion models report "no usable provider key". dsh expands
// the placeholder form below at mount time, so the secret stays in the shell
// environment and never rests in this file. An empty GBRAIN_KEY_VAR (local
// provider, or an explicitly chosen keyless brain) writes no env block at all.
servers.gbrain = Object.assign(
  { type: "stdio", command: process.env.GBRAIN_BIN, args: ["serve"] },
  process.env.GBRAIN_KEY_VAR
    ? { env: { [process.env.GBRAIN_KEY_VAR]: "\${" + process.env.GBRAIN_KEY_VAR + "}" } }
    : {}
);
doc.mcpServers = servers;
writeFileSync(p, JSON.stringify(doc, null, 2) + "\\n");
console.log("registered gbrain (stdio) in " + p);
'
\`\`\`

**Why the \`env\` block matters.** dsh starts a stdio server with its own
environment, not yours, so a key exported in your shell — or present in the dsh
process — is invisible to \`gbrain serve\` unless it is named here. Without it the
brain still starts and still answers keyword queries, which is what hides the
failure: vector search silently degrades to keyword-only and the chat/expansion
models fall back. The verify step below prints \`env\`, so confirm the placeholder
is present. If it is missing, expect
\`[gbrain] vector search unavailable (missing_env)\` in the session console.

### Both paths — verify, then restart

\`\`\`bash
DSH_MCP_JSON="\${DSH_HOME:-$HOME/.dsh}/mcp.json"
# The prefix assignment is required: \`node -e\` reads this from the process
# ENVIRONMENT, so a plain shell variable that is not exported is invisible to it.
DSH_MCP_JSON="$DSH_MCP_JSON" node -e '
const doc = JSON.parse(require("node:fs").readFileSync(process.env.DSH_MCP_JSON, "utf8"));
const row = doc.mcpServers && doc.mcpServers.gbrain;
console.log(row ? "gbrain entry: " + JSON.stringify({ type: row.type, url: row.url, command: row.command, args: row.args, env: row.env }) : "gbrain entry: MISSING");
'
# Shadow check — dsh drops a shadowed entry with no error, so prove none exists.
for f in "$(git rev-parse --show-toplevel 2>/dev/null)/.dsh/mcp.yml" \\
         "$(git rev-parse --show-toplevel 2>/dev/null)/.dsh/mcp.json" \\
         "$(git rev-parse --show-toplevel 2>/dev/null)/.mcp.json" \\
         "\${DSH_HOME:-$HOME/.dsh}/mcp.yml"; do
  [ -f "$f" ] && grep -l 'gbrain' "$f" 2>/dev/null && echo "SHADOWS the user-scope entry: $f"
done
# dsh's own reconciliation record: mounted / unhealthy / skippedByReason.
[ -f "\${DSH_HOME:-$HOME/.dsh}/.mcp-diag.json" ] && cat "\${DSH_HOME:-$HOME/.dsh}/.mcp-diag.json"
\`\`\`

A \`gbrain\` row that is **missing** from the file is a failed write — stop.
A row that is present but never appears in \`.mcp-diag.json\` as mounted means a
higher layer shadowed it (the loop above names the file) or the server failed to
start (the diag record carries the reason). Report which.

**Heads-up for the user:** dsh watches the MCP layer, so a running session picks
the server up without a full restart — but the *tool list* is resolved per
session, so tell them: "Restart this dsh session to see the \`gbrain\` MCP tools
in the model's tool list."`;
}

/**
 * Step 9 of /setup-gbrain — the put → search round trip.
 *
 * Every host except dsh keeps the historical CLI smoke test, byte-for-byte.
 * dsh cannot use it: dsh mounts `gbrain serve` **live** for the whole session
 * and PGLite is a single-writer datastore, so by Step 9 every read/write CLI
 * verb is locked out —
 *
 *   GBrain's local database is already open through `gbrain serve` (MCP, PID …)
 *
 * Only `sources add` and `sync` delegate to the live serve over IPC; `put`,
 * `search` and `sources list` do not (verified on gbrain 0.60.25.0). The dsh
 * branch therefore runs the round trip through the MCP tools the session
 * already has, and checks `embedded_count` as well — the CLI test could pass on
 * a keyless brain, which is the failure mode /setup-gbrain exists to catch.
 */
export function generateGBrainStep9Smoke(ctx: TemplateContext): string {
  if (ctx.host !== 'dsh') {
    return `\`\`\`bash
SLUG="setup-gbrain-smoke-test-$(date +%s)"
echo "Set up on $(date). Smoke test for /setup-gbrain." | gbrain put "$SLUG"
gbrain search "smoke test" | grep -i "$SLUG"
\`\`\`

Confirms the round trip. On failure, surface \`gbrain doctor --json\` output
and STOP with a NEEDS_CONTEXT escalation.`;
  }

  return `Run the round trip through the **MCP tools**, not the CLI. dsh mounts
\`gbrain serve\` live for the whole session and PGLite is a single-writer
datastore, so by this step every read/write CLI verb is locked out:

    GBrain's local database is already open through \`gbrain serve\` (MCP, PID …)

That is expected, not a broken install: only \`gbrain sources add\` and
\`gbrain sync\` delegate to the live serve over IPC. So:

1. \`mcp__gbrain__put_page\` — slug \`inbox/setup-gbrain-smoke-test-<epoch>\`,
   \`type: note\`, one line of body.
2. \`mcp__gbrain__search\` (or \`mcp__gbrain__query\`) for \`smoke test\` and
   confirm the slug comes back.
3. \`mcp__gbrain__get_stats\` — \`page_count\` incremented, and \`embedded_count\`
   rose with it.

Step 3 is the signal the CLI test never checked: a page that embeds proves the
embedding provider is reachable and the vector width matches the engine. If
\`page_count\` rises while \`embedded_count\` stays flat, the brain is running
**keyless** — vector search is silently keyword-only. Fix the provider first
(Step 1.7), and do not report a green smoke test. Do NOT point the new page at
a source whose persistence is a git worktree you intend to reset later.

On failure, STOP with a NEEDS_CONTEXT escalation and surface \`gbrain doctor
--json\` from a shell where no live serve holds the datastore. Never stop the
live serve just to run the CLI verbs — that tears down this session's brain
tools.`;
}
