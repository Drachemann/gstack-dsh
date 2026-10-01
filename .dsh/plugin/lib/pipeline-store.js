/**
 * Disk persistence for pipeline state.
 *
 * ## Why this is separate from `pipeline.js`
 *
 * `pipeline.js` is pure: state in, state out, no I/O. That is what makes it
 * testable and what lets it stay independent of the harness. This module is the
 * one place that touches the filesystem, so the impurity is contained and the
 * failure handling is written once.
 *
 * ## Failure polarity
 *
 * Every method here is total: it never throws at its caller. A workspace whose
 * `.dsh/` tree is missing, read-only, or holds a truncated or corrupt state
 * file must not turn a pipeline call into an error. The state is a convenience
 * for surviving a session boundary; losing it degrades to a fresh run, which is
 * strictly better than refusing to run at all.
 *
 * The corollary matters as much as the rule: a failed **load** and an absent
 * file are both reported as explicit non-`ok` statuses rather than as `null`
 * state, so a caller can never mistake "I could not read your last run" for
 * "you have no last run".
 *
 * @module pipeline-store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { deserializePipelineState, serializePipelineState } from './pipeline.js';

/** State file name, relative to the `.dsh/` state directory. */
export const PIPELINE_STATE_FILE = 'gstack-pipeline.json';

/**
 * Find the project root by walking up from `startDir` looking for `.git`.
 *
 * This mirrors the rule DSH's own skill filesystem uses to locate
 * `{projectRoot}/.dsh/skills`, so the state file and the rendered skills tree
 * agree on what "the project" is.
 *
 * Returns **null** when no `.git` is found, deliberately. An earlier version
 * returned `startDir` to keep the function total, and that was a mistake: at
 * plugin load the Harness process's working directory is the harness home
 * (`~/.dsh`), not the session's project, so the fallback silently resolved state
 * to `~/.dsh/gstack-pipeline.json` — a location that is not a project at all. A
 * caller must be able to tell "I found the project" from "I did not", so the
 * absence is reported rather than papered over.
 *
 * @param {string} startDir - directory to start from.
 * @param {(path: string) => boolean} [hasGit] - injectable predicate for tests.
 * @returns {string|null} the resolved project root, or null when none is found.
 */
export function findProjectRoot(startDir, hasGit = (path) => existsSync(path)) {
  let current = resolve(startDir);
  while (true) {
    if (hasGit(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Resolve the directory pipeline state lives in.
 *
 * `config.stateDir` wins when an operator sets it. Otherwise the state sits
 * beside the rendered skills tree at `{projectRoot}/.dsh/`, which is the one
 * per-project DSH location this port already owns. A caller that supplies
 * neither a config value nor a usable `cwd` gets `null` — persistence is then
 * reported unavailable rather than silently writing somewhere arbitrary.
 *
 * An explicitly blank `stateDir` is a misconfiguration, not an instruction to
 * use the default: it fails closed. Falling back to the working directory there
 * would mean a typo silently persists state somewhere the operator did not
 * choose.
 *
 * @param {object} [options]
 * @param {string} [options.stateDir] - explicit override.
 * @param {string} [options.cwd] - directory to resolve the project root from.
 * @param {(path: string) => boolean} [options.hasGit] - injectable `.git` predicate.
 * @returns {string|null} the state directory, or null when it cannot be resolved.
 */
export function resolveStateDir(options = {}) {
  if (options.stateDir !== undefined) {
    return typeof options.stateDir === 'string' && options.stateDir.trim() !== ''
      ? resolve(options.stateDir.trim())
      : null;
  }
  const cwd = options.cwd ?? (typeof process !== 'undefined' ? process.cwd?.() : undefined);
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;
  const projectRoot = findProjectRoot(cwd, options.hasGit);
  // No project found: report unavailable rather than guessing where state goes.
  // See `findProjectRoot` for why the wrong answer here is worse than none.
  return projectRoot ? join(projectRoot, '.dsh') : null;
}

/**
 * Create a store bound to one state directory.
 *
 * @param {object} [options]
 * @param {string} [options.stateDir] - explicit directory override.
 * @param {string} [options.cwd] - directory to resolve the project root from.
 * @param {(path: string) => boolean} [options.hasGit] - injectable `.git` predicate.
 * @returns {{
 *   available: boolean,
 *   path: string|null,
 *   load: () => object,
 *   save: (state: object) => object,
 *   clear: () => object,
 * }}
 */
export function createPipelineStore(options = {}) {
  const stateDir = resolveStateDir(options);
  const path = stateDir ? join(stateDir, PIPELINE_STATE_FILE) : null;

  if (!path) {
    const unavailable = () => ({
      status: 'unavailable',
      state: null,
      path: null,
      error: 'no state directory could be resolved',
    });
    return { available: false, path: null, load: unavailable, save: unavailable, clear: unavailable };
  }

  return {
    available: true,
    path,

    /** Read the persisted state, reporting why it is absent when it is. */
    load() {
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return { status: 'missing', state: null, path, error: null };
        }
        return { status: 'unreadable', state: null, path, error: String(error?.message || error) };
      }

      try {
        return { status: 'ok', state: deserializePipelineState(text), path, error: null };
      } catch (error) {
        // A corrupt file is reported, never silently overwritten here: the
        // caller decides whether to replace it.
        return { status: 'invalid', state: null, path, error: String(error?.message || error) };
      }
    },

    /** Write state atomically, so a crash mid-write cannot truncate a good file. */
    save(state) {
      let text;
      try {
        text = serializePipelineState(state);
      } catch (error) {
        return { status: 'unserializable', path, error: String(error?.message || error) };
      }

      const tmp = `${path}.tmp`;
      try {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(tmp, text, 'utf8');
        renameSync(tmp, path);
        return { status: 'ok', path, error: null };
      } catch (error) {
        // Leave no partial artifact behind to be mistaken for real state.
        try {
          unlinkSync(tmp);
        } catch {
          /* the temp file was never created, or is already gone */
        }
        return { status: 'unwritable', path, error: String(error?.message || error) };
      }
    },

    /** Remove persisted state. Absent is success, not a failure. */
    clear() {
      try {
        unlinkSync(path);
        return { status: 'ok', path, error: null };
      } catch (error) {
        if (error?.code === 'ENOENT') return { status: 'ok', path, error: null };
        return { status: 'unwritable', path, error: String(error?.message || error) };
      }
    },
  };
}
