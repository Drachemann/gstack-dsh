// Egress receipt wiring — the plugin's one off-machine sink must record before it sends.
//
// These tests exist because `.dsh/plugin/` is invisible to
// `test/egress-receipt-wiring.test.ts` (that scanner's file walk skips
// dot-directories), so the plugin's `fetch` in `lib/jev.js` was the only
// gstack-initiated egress on any host with no receipt and no tripwire.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EGRESS_RECEIPT_FAILED,
  egressHelperCandidates,
  writeEgressReceipt,
} from '../lib/egress-receipt.js';
import { JevClient } from '../lib/jev.js';

const BUN = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0 ? 'bun' : null;

/** A stand-in for bin/gstack-egress-receipt: records order, echoes an id. */
const FAKE_HELPER = `
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const log = process.env.GSTACK_TEST_ORDER_LOG;
if (args[0] === 'write' && log) appendFileSync(log, 'receipt\\n');
if (args[0] === 'write' && process.env.GSTACK_TEST_FAIL_RECEIPT === '1') {
  process.stderr.write('EGRESS_RECEIPT_FAILED: simulated ledger failure\\n');
  process.exit(3);
}
if (args[0] === 'write' && process.env.GSTACK_TEST_CAPTURE) {
  const i = args.indexOf('--payload-file');
  const body = i >= 0 ? readFileSync(args[i + 1], 'utf8') : '';
  appendFileSync(process.env.GSTACK_TEST_CAPTURE, JSON.stringify({ args, body }) + '\\n');
}
process.stdout.write('receipt-test-0001\\n');
`;

/** Run `fn` with a fake helper installed and a stubbed fetch, then restore. */
async function withHarness(fn, { extraEnv = {}, installHelper = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gstack-egress-test-'));
  const helper = join(dir, 'gstack-egress-receipt');
  writeFileSync(helper, FAKE_HELPER);
  const orderLog = join(dir, 'order.log');
  const capture = join(dir, 'capture.jsonl');

  const savedFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    appendFileSync(orderLog, 'fetch\n');
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
    };
  };

  if (installHelper) process.env.GSTACK_DSH_EGRESS_HELPER = helper;
  else delete process.env.GSTACK_DSH_EGRESS_HELPER;
  process.env.GSTACK_TEST_ORDER_LOG = orderLog;
  process.env.GSTACK_TEST_CAPTURE = capture;
  Object.assign(process.env, extraEnv);

  try {
    await fn({
      dir,
      helper,
      orderLog,
      capture,
      calls,
      order: () =>
        existsSync(orderLog) ? readFileSync(orderLog, 'utf8').trim().split('\n').filter(Boolean) : [],
      captured: () =>
        existsSync(capture)
          ? readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
          : [],
    });
  } finally {
    globalThis.fetch = savedFetch;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the receipt is written BEFORE the fetch, once per request', { skip: !BUN && 'bun is required' }, async () => {
  await withHarness(async ({ order, calls }) => {
    const client = new JevClient({ apiKey: 'test-key', retries: 0 });
    await client.triage({ risky: { type: 'noul', instructions: 'how risky is this call' } });

    assert.equal(calls.length, 1, 'exactly one fetch');
    assert.deepEqual(order(), ['receipt', 'fetch'], 'the receipt must be recorded before the send');
  });
});

test('the receipt covers the exact bytes that were sent', { skip: !BUN && 'bun is required' }, async () => {
  await withHarness(async ({ captured, calls }) => {
    const client = new JevClient({ apiKey: 'test-key', retries: 0 });
    await client.triage(
      { risky: { type: 'noul', instructions: 'exact bytes' } },
      { state: 'the-precise-state' }
    );

    const [record] = captured();
    assert.ok(record, 'the helper saw a receipt write');
    const argv = record.args;
    assert.equal(argv[0], 'write');
    assert.equal(argv[argv.indexOf('--sink') + 1], 'dsh-jev-triage');
    assert.equal(argv[argv.indexOf('--host') + 1], 'opencode.ai');
    assert.equal(argv[argv.indexOf('--class') + 1], 'tool-call-shape');
    assert.ok(argv.includes('--consent'), 'a consent string is recorded');

    const sentBody = calls[0].init.body;
    assert.equal(record.body, sentBody, 'the hashed payload file must be the exact request body');
    const parsed = JSON.parse(record.body);
    assert.equal(parsed.state, 'the-precise-state');
    assert.ok(parsed.questions.risky, 'the question payload is intact');
  });
});

test('a failed receipt blocks the send (fail-closed)', { skip: !BUN && 'bun is required' }, async () => {
  await withHarness(
    async ({ order, calls }) => {
      const client = new JevClient({ apiKey: 'test-key', retries: 0 });
      await assert.rejects(
        () => client.triage({ risky: { type: 'noul', instructions: 'must not send' } }),
        (error) => {
          assert.equal(error.code, EGRESS_RECEIPT_FAILED);
          assert.match(error.message, /EGRESS_RECEIPT_FAILED/);
          return true;
        }
      );
      assert.equal(calls.length, 0, 'NO byte may leave the machine without a receipt');
      assert.deepEqual(order(), ['receipt'], 'the receipt attempt happened and the send did not');
    },
    { extraEnv: { GSTACK_TEST_FAIL_RECEIPT: '1' } }
  );
});

test('a missing helper blocks the send and names the repair', { skip: !BUN && 'bun is required' }, async () => {
  await withHarness(
    async ({ dir, calls }) => {
      // No override, no GSTACK_ROOT, an empty HOME and an empty cwd: every
      // candidate path is absent, which is the uninstalled-machine case.
      process.env.GSTACK_DSH_EGRESS_HELPER = join(dir, 'does-not-exist');
      process.env.GSTACK_ROOT = join(dir, 'no-root');
      process.env.HOME = join(dir, 'no-home');
      process.chdir(dir);

      const client = new JevClient({ apiKey: 'test-key', retries: 0 });
      await assert.rejects(
        () => client.triage({ risky: { type: 'noul', instructions: 'no helper' } }),
        (error) => {
          assert.equal(error.code, EGRESS_RECEIPT_FAILED);
          assert.match(error.message, /no gstack-egress-receipt found/);
          assert.match(error.message, /GSTACK_DSH_EGRESS_HELPER/, 'the override is named');
          return true;
        }
      );
      assert.equal(calls.length, 0);
    },
    { installHelper: false }
  );
});

test('helper resolution prefers an explicit override, then $GSTACK_ROOT', () => {
  const candidates = egressHelperCandidates(
    { GSTACK_DSH_EGRESS_HELPER: '/explicit/helper', GSTACK_ROOT: '/root/gstack', HOME: '/home/x' },
    '/proj'
  );
  assert.equal(candidates[0], '/explicit/helper');
  assert.ok(candidates.includes(join('/root/gstack', 'bin', 'gstack-egress-receipt')));
  assert.ok(candidates.includes(join('/proj', '.dsh', 'skills', 'gstack', 'bin', 'gstack-egress-receipt')));
  assert.ok(candidates.includes(join('/home/x', '.dsh', 'skills', 'gstack', 'bin', 'gstack-egress-receipt')));
});

test('writeEgressReceipt rejects a missing required field without spawning', () => {
  assert.throws(
    () => writeEgressReceipt({ sink: 's', host: 'h', payloadClass: 'c', body: '' }),
    /body/
  );
});
