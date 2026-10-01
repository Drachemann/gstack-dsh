/**
 * Egress receipt bridge — the fail-closed half of the plugin's one off-machine send.
 *
 * `jev.js` POSTs the gated tool call's name and verbatim arguments to
 * `https://opencode.ai/zen/v1/systemone`. That is the plugin's ONLY `fetch`, and
 * until this module existed it was the only gstack-initiated egress on any host
 * with no receipt: `test/egress-receipt-wiring.test.ts` scans for new sinks with
 * a walk that skips dot-directories, so `.dsh/plugin/` was invisible to it.
 *
 * gstack's contract is that every off-machine sink writes a hash-chained receipt
 * to `~/.gstack/security/egress.jsonl` BEFORE the send (see CLAUDE.md, "Egress
 * receipts at every off-machine sink"). This module is the plugin's caller of
 * that contract.
 *
 * ## Why shell out instead of reimplementing the ledger
 *
 * The ledger is a hash chain (`lib/egress-receipt.ts`). A second, hand-written
 * implementation in plain JS would silently break `bin/gstack-egress verify`
 * (exit 3 on tamper) the first time the canonical writer changed. dsh runs the
 * plugin on Node, and the plugin has no build step, so the canonical TypeScript
 * cannot be imported directly. The shipped bridge is therefore
 * `bin/gstack-egress-receipt`, which owns the format in exactly one place.
 *
 * ## Polarity
 *
 * Fail-closed. If the receipt cannot be written — helper missing, `bun` missing,
 * non-zero exit — {@link writeEgressReceipt} throws and `#request` refuses the
 * fetch. The send does not happen without a receipt.
 *
 * That is deliberately NOT the same as failing the tool call closed: `index.js`
 * catches a Jev failure and lets the call through to the Harness approval policy
 * and sandbox, which are the authoritative gates. The invariant this module
 * enforces is narrower and absolute: an unrecorded egress attempt is never made.
 *
 * @module gstack-dsh/egress-receipt
 */

import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Machine-readable prefix, matching `lib/egress-receipt.ts`'s constant. */
export const EGRESS_RECEIPT_FAILED = 'EGRESS_RECEIPT_FAILED';

/** The bridge script, relative to a gstack runtime root. */
const HELPER_RELATIVE = join('bin', 'gstack-egress-receipt');

/** Consent string recorded on every receipt this plugin writes. */
export const JEV_EGRESS_CONSENT = 'gstack-dsh plugin config: risk gate enabled';

/**
 * Candidate runtime roots, most specific first.
 *
 * Mirrors the rendered preamble's own preference: an explicit override wins,
 * then a project-local install, then the user root. `GSTACK_ROOT` is honored
 * because a dsh session started through a skill preamble exports it.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} cwd
 * @returns {string[]}
 */
export function egressHelperCandidates(env = process.env, cwd = process.cwd()) {
  const candidates = [];
  const explicit = env.GSTACK_DSH_EGRESS_HELPER;
  if (explicit) candidates.push(isAbsolute(explicit) ? explicit : join(cwd, explicit));
  if (env.GSTACK_ROOT) candidates.push(join(env.GSTACK_ROOT, HELPER_RELATIVE));
  const projectRoot = env.GSTACK_DSH_PROJECT_ROOT || cwd;
  candidates.push(join(projectRoot, '.dsh', 'skills', 'gstack', HELPER_RELATIVE));
  candidates.push(join(env.HOME || homedir(), '.dsh', 'skills', 'gstack', HELPER_RELATIVE));
  return candidates;
}

/** A receipt that could not be written. Callers MUST NOT send. */
export class EgressReceiptError extends Error {
  constructor(message, cause) {
    super(`${EGRESS_RECEIPT_FAILED}: ${message}`);
    this.name = 'EgressReceiptError';
    this.code = EGRESS_RECEIPT_FAILED;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Resolve an executable, or null when `bun` is not on PATH. */
function resolveBun(env) {
  const pathValue = env.PATH || process.env.PATH || '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of pathValue.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `bun${ext}`);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/**
 * Write the pre-send receipt for one request body.
 *
 * The body is written to a private temp file FIRST and that exact file is what
 * the bridge hashes and what the caller sends, so the recorded hash covers the
 * bytes that actually leave the machine (the scan-at-sink rule).
 *
 * @param {object} opts
 * @param {string} opts.sink - which component is sending.
 * @param {string} opts.host - destination host[:port].
 * @param {string} opts.payloadClass - content-free payload description.
 * @param {string} opts.body - the EXACT request body to be sent.
 * @param {string} [opts.consent]
 * @param {Record<string,string|undefined>} [opts.env]
 * @param {string} [opts.cwd]
 * @returns {{id: string, path: string}} the recorded receipt.
 * @throws {EgressReceiptError} when no receipt can be written.
 */
export function writeEgressReceipt(opts) {
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  const { sink, host, payloadClass, body } = opts;
  for (const [name, value] of Object.entries({ sink, host, payloadClass, body })) {
    if (typeof value !== 'string' || value === '') {
      throw new EgressReceiptError(`missing required receipt field: ${name}`);
    }
  }

  const bun = resolveBun(env);
  if (!bun) {
    throw new EgressReceiptError(
      'bun is not on PATH, so the receipt bridge cannot run. Install bun, or point ' +
        'GSTACK_DSH_EGRESS_HELPER at a compatible gstack-egress-receipt.'
    );
  }

  const candidates = egressHelperCandidates(env, cwd);
  const helper = candidates.find((candidate) => existsSync(candidate));
  if (!helper) {
    throw new EgressReceiptError(
      `no gstack-egress-receipt found (looked in: ${candidates.join(', ')}). ` +
        'Run ./setup --host dsh to install the runtime root, or set GSTACK_DSH_EGRESS_HELPER.'
    );
  }

  let workdir;
  try {
    workdir = mkdtempSync(join(tmpdir(), 'gstack-dsh-egress-'));
    const payloadFile = join(workdir, 'payload.json');
    writeFileSync(payloadFile, body, { encoding: 'utf8', mode: 0o600 });

    const result = spawnSync(
      bun,
      [
        helper,
        'write',
        '--sink', sink,
        '--host', host,
        '--class', payloadClass,
        '--payload-file', payloadFile,
        '--consent', opts.consent || JEV_EGRESS_CONSENT,
      ],
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'], env }
    );

    if (result.error) {
      throw new EgressReceiptError(`receipt bridge could not run: ${result.error.message}`, result.error);
    }
    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim();
      throw new EgressReceiptError(
        `receipt bridge exited ${result.status}${stderr ? `: ${stderr}` : ''}`
      );
    }
    const id = (result.stdout || '').trim();
    if (!id) {
      throw new EgressReceiptError('receipt bridge exited 0 without printing a receipt id');
    }
    return { id, path: helper };
  } finally {
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  }
}

/**
 * Record a response status against a receipt. Best-effort by design: the
 * pre-send receipt is the invariant, the outcome is bookkeeping, and a failure
 * here must never fail the tool call.
 */
export function recordEgressOutcome(receiptId, status, opts = {}) {
  try {
    if (!receiptId) return false;
    const env = opts.env || process.env;
    const bun = resolveBun(env);
    if (!bun) return false;
    const helper = egressHelperCandidates(env, opts.cwd || process.cwd()).find((candidate) =>
      existsSync(candidate)
    );
    if (!helper) return false;
    spawnSync(bun, [helper, 'outcome', receiptId, String(status)], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'ignore',
      env,
    });
    return true;
  } catch {
    return false;
  }
}
