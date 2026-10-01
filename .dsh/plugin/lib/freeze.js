/**
 * Freeze boundary — the DeepSeek Harness enforcement arm of `/gstack-freeze`
 * and `/gstack-guard`.
 *
 * On Claude Code the boundary is enforced by `freeze/bin/check-freeze.sh`, a
 * `PreToolUse` hook that DENIES an edit whose `file_path` resolves outside the
 * frozen directory. dsh has no hook mechanism, so before this module the skill
 * wrote state nothing read: `/freeze` and `/guard` reported success and every
 * edit was allowed. This is the same re-expression `/gstack-careful` got, on the
 * surface that already exists (`tools/pre-execute`).
 *
 * The semantics are deliberately a mirror of the hook, not a reinterpretation,
 * because the two must agree: same state root, same file format, same symlink
 * resolution, same containment test, same fail-closed polarity. The hook's own
 * comments record why each of those is the way it is (#1459/#1509 state-root
 * drift, the in-boundary-symlink escape). Where this file diverges it says so.
 *
 * Polarity: freeze is a DENY-tier gate. A boundary that fails open is not a
 * boundary — but "the boundary file does not exist" is *not* a failure, it means
 * the feature is unconfigured, and that must allow. The distinction is made
 * explicitly in {@link readFreezeBoundary}.
 *
 * @module gstack-dsh/freeze
 */

import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

/** File tools the boundary governs, mapped to the argument carrying the target. */
export const BOUNDARY_TOOLS = new Map([
  ['write', 'file_path'],
  ['edit', 'file_path'],
]);

/** Bound on the final-component symlink chase, matching the hook's loop guard. */
const MAX_SYMLINK_HOPS = 40;

/**
 * The state file, resolved exactly as `gstack_hook_state_root` resolves it
 * (`careful/bin/hook-extract.sh`). Drift between the writer and this reader is
 * the historical failure this mirrors: with `GSTACK_HOME` set, `/freeze` wrote
 * under `GSTACK_HOME` while the reader looked in `$HOME/.gstack`, found nothing,
 * and allowed everything (#1459, #1509).
 *
 * `CLAUDE_PLUGIN_DATA` is kept for byte-compatibility with the shell resolver.
 * It cannot be reached on dsh, but removing it here would make the two roots
 * disagree on a host that has both installed.
 */
export function freezeStateFile(env = process.env, home = homedir()) {
  if (env.GSTACK_HOME) return join(env.GSTACK_HOME, 'freeze-dir.txt');
  if (env.CLAUDE_PLUGIN_DATA && /gstack/i.test(env.CLAUDE_PLUGIN_ROOT || '')) {
    return join(env.CLAUDE_PLUGIN_DATA, 'freeze-dir.txt');
  }
  if (home) return join(home, '.gstack', 'freeze-dir.txt');
  return join('.gstack', 'freeze-dir.txt');
}

/**
 * Read the active boundary.
 *
 * @returns {{active: boolean, dir: string|null, reason: string}}
 *   `active: false` means "not configured" and MUST allow. `deny: true` means a
 *   boundary exists but is unusable, which fails closed (see {@link checkBoundary}).
 */
export function readFreezeBoundary(file = freezeStateFile()) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { active: false, deny: false, dir: null, reason: 'no boundary configured' };
  }

  const lines = raw.split('\n');
  const first = lines[0] ?? '';
  const second = lines[1] ?? '';
  // The hook only trims a legacy file (one written before the versioned marker);
  // a v1 file's boundary is taken verbatim, so a path with meaningful surrounding
  // whitespace cannot be silently reinterpreted.
  let dir = second.startsWith('gstack-freeze-v1:') ? first : first.trim();

  // A literal leading `~` never matches an absolute tool path, so expand it.
  if (dir === '~') dir = homedir();
  else if (dir.startsWith('~/')) dir = join(homedir(), dir.slice(2));

  // Empty boundary: the hook allows (a torn write, not a boundary).
  if (!dir) return { active: false, deny: false, dir: null, reason: 'boundary is empty' };

  // A relative boundary is ambiguous — we cannot know what it is relative to.
  // The hook denies here; so does this, rather than guessing a base directory.
  if (!isAbsolute(dir)) {
    return {
      active: true,
      deny: true,
      dir: null,
      reason:
        'the saved freeze boundary is relative and therefore ambiguous; re-run /gstack-freeze with an absolute directory',
    };
  }

  return { active: true, deny: false, dir, reason: 'active' };
}

/** `lstat` that reports "not a symlink" instead of throwing on a missing path. */
function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Resolve a path the way `check-freeze.sh:_resolve_path` does: follow the final
 * component's symlink chain (bounded), then resolve the parent physically.
 *
 * Following the FINAL component matters. Resolving only the parent let an
 * in-boundary symlink pointing at an out-of-boundary target pass the check while
 * the write landed outside the boundary.
 */
export function resolvePhysical(p) {
  let cur = p;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS && isSymlink(cur); hop += 1) {
    let target;
    try {
      target = readlinkSync(cur);
    } catch {
      break;
    }
    cur = isAbsolute(target) ? target : join(dirname(cur), target);
  }
  const dir = dirname(cur);
  const base = basename(cur);
  if (base === '/') return '/';
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    // A parent that does not exist yet (a new nested directory) has nothing to
    // resolve; the lexical parent is the correct answer, as in the hook.
  }
  return `${real.replace(/\/+$/, '')}/${base}`;
}

/** Normalize the way the hook does: collapse runs of `/`, strip a trailing `/`. */
export function normalizePath(p) {
  const collapsed = p.replace(/\/+/g, '/').replace(/\/$/, '');
  return collapsed === '' ? '/' : collapsed;
}

/**
 * The hook's containment test: the target is the boundary itself or lives under
 * it. `boundary === '/'` therefore contains everything, which is what a
 * root-level freeze means.
 */
export function isInside(target, boundary) {
  const b = boundary.replace(/\/+$/, '') || '/';
  if (target === b || b === '/') return true;
  return target.startsWith(`${b}/`);
}

/**
 * Decide whether one tool call crosses the boundary.
 *
 * Returns `null` to allow, or `{reason}` to deny — shaped for the gate's
 * deny branch. The check runs BEFORE Jev: a hard boundary must not depend on a
 * model's judgment, and must not spend a decision to reach a deterministic
 * answer.
 *
 * @param {{name?: string, arguments?: Record<string, unknown>}} exec
 * @param {{file?: string, cwd?: string}} [opts] - injectable for tests.
 */
export function checkBoundary(exec, opts = {}) {
  if (!exec || !BOUNDARY_TOOLS.has(exec.name)) return null;

  const boundary = readFreezeBoundary(opts.file ?? freezeStateFile());

  // Not configured, or a torn/empty state file: allow.
  if (!boundary.active && !boundary.deny) return null;

  // A boundary exists but cannot be trusted (relative/ambiguous). Fail closed,
  // exactly as the deny-tier hook does.
  if (boundary.deny) {
    return { reason: `The /gstack-freeze boundary is unusable: ${boundary.reason}. Blocked. Run /gstack-unfreeze to clear it.` };
  }

  const argName = BOUNDARY_TOOLS.get(exec.name);
  const rawTarget = exec.arguments?.[argName];
  // Parsed but no path argument: not a file-targeted call — allow, as the hook
  // does for a payload without `file_path`.
  if (typeof rawTarget !== 'string' || rawTarget === '') return null;

  // Resolve a relative target the way the harness resolves it when it WRITES:
  // against the SESSION's workspace cwd (dsh-tool-fs uses
  // `exec.agent?.session.header.cwd`), never the host process cwd — on dsh that
  // is the harness home (~/.dsh), not the project. Disagreeing bases let a
  // relative path be checked inside the boundary and written outside it.
  const sessionCwdRaw = opts.cwd ?? exec?.agent?.session?.header?.cwd;
  const sessionCwd = typeof sessionCwdRaw === 'string' && sessionCwdRaw !== '' ? sessionCwdRaw : null;
  if (!isAbsolute(rawTarget) && !sessionCwd) {
    // A relative target with no knowable base cannot be evaluated. Freeze is
    // deny-tier, so fail closed rather than guess a directory.
    return {
      reason:
        'Blocked by the gstack-dsh freeze boundary: a relative path was given but the session working directory could not be determined, so it cannot be checked. Retry with an absolute path, or run /gstack-unfreeze.',
    };
  }
  const absolute = isAbsolute(rawTarget) ? rawTarget : join(sessionCwd, rawTarget);
  const target = resolvePhysical(normalizePath(absolute));
  const dir = resolvePhysical(normalizePath(boundary.dir));

  if (isInside(target, dir)) return null;

  return {
    reason:
      `Blocked by the gstack-dsh freeze boundary: ${target} is outside ${dir}. ` +
      `Only edits within the frozen directory are allowed. Run /gstack-unfreeze to widen, or make the edit inside the boundary.`,
  };
}
