/**
 * Risk-gate coverage: the `tools/pre-execute` listener body and
 * `classifyToolCall`, driven through a REAL `on:` harness.
 *
 * The review that found this gap noted that every prior test passed a no-op
 * `on: () => () => {}`, so `registerRiskGate`'s listener body — the code that
 * decides whether a destructive tool call is denied — had zero coverage. These
 * tests capture the handler the plugin actually registers and invoke it with
 * production-shaped exec payloads.
 *
 * Jev is stubbed at the network boundary (a fake `fetch`), so the scorer,
 * the verdict mapping, and the freeze/egress wiring are all the real code.
 * Receipts are redirected to a temp GSTACK_HOME so the suite never writes the
 * operator's ledger.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const CARE_FILE = join(homedir(), '.gstack', 'careful.json');

/** System One answer shape: `{ type, <type>: value }`. */
function answers({ risk = 0.1, irreversible = 0.1, injection = 0.1, fit = 0.9 } = {}) {
  return {
    risky: { type: 'noul', noul: risk },
    irreversible: { type: 'noul', noul: irreversible },
    injection: { type: 'noul', noul: injection },
    fit: { type: 'noul', noul: fit },
  };
}

/**
 * Apply the plugin against a fake cordis ctx and return the registered
 * `tools/pre-execute` handler plus the request log.
 */
async function harness({ answerSet = answers(), fetchImpl } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gstack-gate-'));
  const stateDir = join(dir, '.dsh');
  mkdirSync(stateDir, { recursive: true });

  const savedFetch = globalThis.fetch;
  const savedHome = process.env.GSTACK_HOME;
  const savedCare = existsSync(CARE_FILE) ? readFileSync(CARE_FILE, 'utf8') : null;
  if (savedCare === null) rmSync(CARE_FILE, { force: true });

  process.env.GSTACK_HOME = dir;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: init?.body });
    if (fetchImpl) return fetchImpl(url, init);
    return { ok: true, status: 200, json: async () => ({ answers: answerSet, usage: {} }) };
  };

  const { apply } = await import('../lib/index.js');
  let preExecute = null;
  const ctx = {
    tools: { register: () => {} },
    logger: { info: () => {} },
    on: (event, handler) => {
      if (event === 'tools/pre-execute') preExecute = handler;
      return () => {};
    },
    llm: {
      async prepareCall() {
        throw new Error('llm must not be reached from the risk gate');
      },
    },
  };
  apply(ctx, { log: () => {}, apiKey: 'test-key', stateDir });

  assert.ok(preExecute, 'the plugin must register a tools/pre-execute handler');

  return {
    requests,
    run: async (exec) => {
      let nextCalled = false;
      const outcome = await preExecute(exec, async () => {
        nextCalled = true;
        return { kind: 'allow', via: 'next' };
      });
      return { outcome, nextCalled };
    },
    async cleanup() {
      globalThis.fetch = savedFetch;
      if (savedHome === undefined) delete process.env.GSTACK_HOME;
      else process.env.GSTACK_HOME = savedHome;
      if (savedCare === null) rmSync(CARE_FILE, { force: true });
      else {
        mkdirSync(join(homedir(), '.gstack'), { recursive: true });
        writeFileSync(CARE_FILE, savedCare);
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const writeExec = (filePath) => ({ name: 'write', arguments: { file_path: filePath } });

test('an exempt tool bypasses the gate without spending a Jev decision', async () => {
  const h = await harness();
  try {
    const { outcome, nextCalled } = await h.run({ name: 'read', arguments: { file_path: '/etc/hosts' } });
    assert.equal(nextCalled, true, 'exempt tools continue');
    assert.deepEqual(outcome, { kind: 'allow', via: 'next' });
    assert.equal(h.requests.length, 0, 'no classification call for an exempt tool');
  } finally {
    await h.cleanup();
  }
});

test('a confident danger is denied, and the reason carries both probabilities', async () => {
  const h = await harness({ answerSet: answers({ risk: 0.95, irreversible: 0.9 }) });
  try {
    const { outcome, nextCalled } = await h.run(writeExec('/etc/passwd'));
    assert.equal(nextCalled, false, 'a denied call must not continue');
    assert.equal(outcome.kind, 'deny');
    assert.match(outcome.reason, /risk gate/);
    assert.match(outcome.reason, /risk p=0\.95/);
    assert.match(outcome.reason, /irreversibility p=0\.90/);
    assert.equal(h.requests.length, 1, 'exactly one classification call');
    // The gate sends the tool name plus the verbatim argument shape.
    assert.match(h.requests[0].body, /write/);
    assert.match(h.requests[0].body, /\/etc\/passwd/);
  } finally {
    await h.cleanup();
  }
});

test('an ambiguous verdict is recorded and allowed with no safety mode set', async () => {
  const h = await harness({ answerSet: answers({ risk: 0.6, irreversible: 0.2 }) });
  try {
    const { outcome, nextCalled } = await h.run(writeExec('/tmp/x'));
    assert.equal(nextCalled, true, 'uncertainty must not stop automation by default');
    assert.equal(outcome.kind, 'allow');
  } finally {
    await h.cleanup();
  }
});

test('the same ambiguous verdict BLOCKS once /gstack-careful sets the marker', async () => {
  const h = await harness({ answerSet: answers({ risk: 0.6, irreversible: 0.2 }) });
  try {
    mkdirSync(join(homedir(), '.gstack'), { recursive: true });
    writeFileSync(
      CARE_FILE,
      `${JSON.stringify({ mode: 'careful', since: new Date().toISOString() })}\n`
    );

    const { outcome, nextCalled } = await h.run(writeExec('/tmp/x'));
    assert.equal(nextCalled, false, 'careful mode blocks the ambiguous band');
    assert.equal(outcome.kind, 'ask');
  } finally {
    await h.cleanup();
  }
});

test('an off-task call (low fit) is treated as ambiguous', async () => {
  const h = await harness({ answerSet: answers({ risk: 0.1, irreversible: 0.1, fit: 0.1 }) });
  try {
    const { nextCalled } = await h.run(writeExec('/tmp/x'));
    assert.equal(nextCalled, true, 'off-task alone observes, it does not deny');
  } finally {
    await h.cleanup();
  }
});

test('an unreachable Jev fails OPEN at the gate, but still receipts the attempt', async () => {
  const h = await harness({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  try {
    const { outcome, nextCalled } = await h.run(writeExec('/tmp/x'));
    assert.equal(nextCalled, true, 'a transient network error must not brick the session');
    assert.equal(outcome.kind, 'allow');
    // Default retries = 2, so one logical request makes three wire attempts.
    assert.equal(h.requests.length, 3, 'the send was attempted once plus two retries');
    // Fail-closed on the SEND is a separate invariant from fail-open on the
    // gate. The receipt is per logical request (retries reuse it), and it is
    // written before the first attempt.
    const ledger = join(process.env.GSTACK_HOME, 'security', 'egress.jsonl');
    assert.ok(existsSync(ledger), 'a receipt was written');
    const lines = readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'one receipt per logical request, not per wire attempt');
    const record = JSON.parse(lines[0]);
    assert.equal(record.sink, 'dsh-jev-triage');
    assert.equal(record.host, 'opencode.ai');
    assert.equal(record.payload_class, 'tool-call-shape');
    assert.match(record.sha256, /^[0-9a-f]{64}$/);
  } finally {
    await h.cleanup();
  }
});

test('the gate denies on the freeze boundary before consulting Jev at all', async () => {
  const h = await harness();
  const dir = mkdtempSync(join(tmpdir(), 'gstack-gate-freeze-'));
  const frozen = join(dir, 'frozen');
  mkdirSync(frozen, { recursive: true });
  const boundaryFile = join(dir, 'freeze-dir.txt');
  writeFileSync(boundaryFile, `${frozen}\ngstack-freeze-v1:test\n`);

  const { checkBoundary } = await import('../lib/freeze.js');
  const hit = checkBoundary(writeExec(join(dir, 'outside.txt')), { file: boundaryFile });
  assert.ok(hit, 'a write outside the boundary is refused');
  assert.match(hit.reason, /freeze boundary/);

  try {
    // And the boundary check is what the live listener calls first: with a
    // boundary active, an outside write never reaches classification.
    const realStateFile = join(process.env.GSTACK_HOME, 'freeze-dir.txt');
    writeFileSync(realStateFile, `${frozen}\ngstack-freeze-v1:test\n`);
    const { outcome, nextCalled } = await h.run(writeExec(join(dir, 'outside.txt')));
    assert.equal(nextCalled, false);
    assert.equal(outcome.kind, 'deny');
    assert.equal(h.requests.length, 0, 'no Jev decision is spent on a deterministic boundary');
    rmSync(realStateFile, { force: true });
  } finally {
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
