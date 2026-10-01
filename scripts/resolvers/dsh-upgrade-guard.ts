import type { TemplateContext } from './types';

/**
 * DSH install note for `/gstack-upgrade` — host-gated, inert for every other host.
 *
 * The template puts this placeholder where the Step 2 heading would be, and for
 * a non-dsh host the resolver returns that heading verbatim, so their rendered
 * bytes stay byte-identical. Only the dsh render gains the note above it.
 *
 * Why the note exists: a dsh install is a symlink farm (`$DSH_HOME/skills/gstack/*`
 * point into the gstack-dsh source checkout) and `.git` is deliberately absent
 * from the runtime root (doc 09 section 7 — linking the checkout's `.git` would
 * let an upgrade mutate the plugin's own git state). `/gstack-upgrade`'s Step 2
 * chain probes for `.git`, finds none, and classifies the install as
 * `vendored-global`. Step 4's vendored branch then clones
 * `https://github.com/garrytan/gstack.git` — the UPSTREAM repo, which has no dsh
 * host, no `INSTALL_DSH`, and no `--host dsh` arm — moves the working install to
 * `.bak`, and runs `./setup --host dsh` against upstream. Setup fails, the backup
 * is restored, and the upgrade can never succeed that way.
 *
 * Verified against the live install: detection reported
 * `vendored-global at /home/matt/.dsh/skills/gstack`, `OLD_VERSION=1.91.10.0`,
 * and `git ls-tree upstream/main` contains no `hosts/dsh`.
 *
 * The probe resolves the checkout the same way the kernel resolves the asset
 * symlinks (`cd` into the linked `bin/`, then `..`), which is the only route that
 * works with `.git` deliberately absent.
 */

const STEP2_HEADING = '### Step 2: Detect install type';

const GUARD = `## DSH INSTALL NOTE (run this before Step 2)

\`\`\`bash
_DSH_HOME="\${DSH_HOME:-$HOME/.dsh}"
_DSH_ROOT="$_DSH_HOME/skills/gstack"
if [ -L "$_DSH_ROOT/bin" ] && [ ! -e "$_DSH_ROOT/.git" ]; then
  # 'pwd -P' because bash's 'cd ..' is logical: from the SYMLINKED bin/ it would
  # land back on $_DSH_ROOT, not on the checkout, and 'git rev-parse' would fail.
  _DSH_BIN_REAL=$(cd "$_DSH_ROOT/bin" 2>/dev/null && pwd -P)
  _DSH_SRC=$(cd "$(dirname "$_DSH_BIN_REAL")" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null || true)
  [ -n "$_DSH_SRC" ] || _DSH_SRC=$(dirname "$_DSH_BIN_REAL")
  echo "DSH_CHECKOUT_MANAGED: $_DSH_ROOT is a symlink farm into $_DSH_SRC; .git is deliberately absent"
  echo "Upgrade the checkout, then re-run setup -- do NOT run Step 4's vendored swap:"
  echo "  cd $_DSH_SRC && git fetch origin && git pull --ff-only && ./setup --host dsh"
fi
\`\`\`

If \`DSH_CHECKOUT_MANAGED\` is printed, **STOP before Step 2 and skip Step 4's vendored branch**:
report the checkout path and the three commands above. Step 2's chain classifies this runtime
root as \`vendored-global\`, and Step 4 would clone \`https://github.com/garrytan/gstack.git\`
(upstream, which has no dsh host), move the working install aside, and fail. Nothing is lost —
the backup is restored — but the upgrade can never succeed that way.

---

`;

export function generateDshUpgradeGuard(ctx: TemplateContext): string {
  if (ctx.host !== 'dsh') return STEP2_HEADING;
  if (ctx.skillName !== 'gstack-upgrade') return STEP2_HEADING;
  return `${GUARD}${STEP2_HEADING}`;
}
