// Regression tests for the fixes made from the /gstack-review pass on
// feat/dsh-host-workflows. Each test fails on the pre-fix code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkBoundary } from '../lib/freeze.js';
import {
  CRITICALITY,
  DEFAULT_BUDGET,
  createEscalationState,
  escalationModelEntries,
  recordEscalation,
  shouldEscalate,
} from '../lib/escalation.js';

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gstack-review-fix-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write the freeze state file the way freeze/bin/freeze-state.sh does. */
function writeBoundary(path, boundaryDir) {
  writeFileSync(path, `${boundaryDir}\ngstack-freeze-v1:test-owner\n`);
}

test('freeze resolves a relative file_path against the SESSION cwd, not process.cwd()', () => {
  withTemp((root) => {
    const frozen = join(root, 'frozen');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(frozen);
    mkdirSync(elsewhere);
    const file = join(root, 'state.txt');
    writeBoundary(file, frozen);

    // The harness resolves `file_path` against exec.agent.session.header.cwd.
    // A relative write from inside the boundary must be allowed.
    const allowed = checkBoundary(
      { name: 'write', arguments: { file_path: 'inside.txt' }, agent: { session: { header: { cwd: frozen } } } },
      { file }
    );
    assert.equal(allowed, null, 'a relative path under the session cwd is inside the boundary');

    // The same relative path from a session rooted elsewhere is outside it.
    const denied = checkBoundary(
      { name: 'write', arguments: { file_path: 'inside.txt' }, agent: { session: { header: { cwd: elsewhere } } } },
      { file }
    );
    assert.ok(denied, 'a relative path from another cwd is outside the boundary');
    assert.match(denied.reason, /elsewhere/);
  });
});

test('freeze fails closed when a relative path has no resolvable session cwd', () => {
  withTemp((root) => {
    const frozen = join(root, 'frozen');
    mkdirSync(frozen);
    const file = join(root, 'state.txt');
    writeBoundary(file, frozen);

    const verdict = checkBoundary({ name: 'write', arguments: { file_path: 'inside.txt' } }, { file });
    assert.ok(verdict, 'an unevaluable relative path must deny, never guess process.cwd()');
    assert.match(verdict.reason, /session working directory could not be determined/);
  });
});

test('freeze still allows an absolute path inside the boundary', () => {
  withTemp((root) => {
    const frozen = join(root, 'frozen');
    mkdirSync(frozen);
    const file = join(root, 'state.txt');
    writeBoundary(file, frozen);

    const verdict = checkBoundary({ name: 'write', arguments: { file_path: join(frozen, 'a.txt') } }, { file });
    assert.equal(verdict, null);
  });
});

test('escalation routes keep the provider, so their model lists are not silently empty', () => {
  const entries = escalationModelEntries([
    { id: 'big-pickle', provider: 'opencode' },
    { id: 'some-free', provider: 'openrouter' },
  ]);
  const byRoute = Object.fromEntries(entries.map((e) => [e.route, e.models]));
  assert.equal(byRoute['opencode-free'].length, 1, 'opencode route lists its discovered model');
  assert.equal(byRoute['opencode-free'][0].id, 'big-pickle');
  assert.equal(byRoute['openrouter-free'].length, 1, 'openrouter route lists its discovered model');
});

test('the per-decision budget is enforced, and session/stage caps still win', () => {
  // perDecision binds: only this decision is spent, session and stage have room.
  const state = createEscalationState();
  const budget = { ...DEFAULT_BUDGET, perDecision: 1, perStage: 99, perSession: 99 };
  recordEscalation(state, { decisionName: 'architecture_sound', stage: 'plan' });
  const capped = shouldEscalate({
    decisionName: 'architecture_sound',
    confidence: 0.5,
    criticality: CRITICALITY.CRITICAL,
    stage: 'plan',
    budget,
    state,
  });
  assert.equal(capped.escalate, false);
  assert.equal(capped.budgetExhausted, 'decision');

  // A different decision in the same session still has its own allowance.
  const other = shouldEscalate({
    decisionName: 'production_bug_risk',
    confidence: 0.5,
    criticality: CRITICALITY.CRITICAL,
    stage: 'plan',
    budget,
    state,
  });
  assert.equal(other.escalate, true);
  assert.equal(other.budgetExhausted, null);

  // Precedence is unchanged: the session cap is reported when it binds first.
  const sessionState = createEscalationState();
  const sessionBudget = { ...DEFAULT_BUDGET, perDecision: 99, perSession: 1, perStage: 99 };
  recordEscalation(sessionState, { decisionName: 'architecture_sound', stage: 'plan' });
  const sessionCapped = shouldEscalate({
    decisionName: 'architecture_sound',
    confidence: 0.5,
    criticality: CRITICALITY.CRITICAL,
    stage: 'plan',
    budget: sessionBudget,
    state: sessionState,
  });
  assert.equal(sessionCapped.budgetExhausted, 'session');
});
