/**
 * Static tripwire for the gstack-dsh plugin's two review findings that no
 * existing scanner could see:
 *
 *   1. `.dsh/plugin/lib/jev.js` was the only gstack-initiated `fetch` on any
 *      host with no egress receipt. `test/egress-receipt-wiring.test.ts` is the
 *      canonical new-sink scanner, but its file walk SKIPS dot-directories, so
 *      `.dsh/plugin/` was invisible to it. This test is the dot-directory arm
 *      of that scanner: any network sink under `.dsh/plugin/` must be in a file
 *      that records a receipt before it sends.
 *
 *   2. `.dsh/plugin/test/` (node:test) ran in no CI root: `bun test
 *      .dsh/plugin/test/` discovers ZERO files because bun does not descend
 *      into dot-directories. Adding it to `TEST_ROOTS` would silently discover
 *      nothing, so the fix is a `node --test` step. This test pins that the
 *      step exists and is merge-blocking, so the suite cannot silently fall
 *      out of CI again.
 *
 * Same wiring-tripwire class as test/free-tests-workflow-wiring.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { TEST_ROOTS } from '../scripts/test-free-shards';

const ROOT = path.resolve(import.meta.dir, '..');
const PLUGIN_LIB = path.join(ROOT, '.dsh', 'plugin', 'lib');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'free-tests.yml');
const PACKAGE_JSON = path.join(ROOT, 'package.json');

/** Network sinks that must carry a receipt. Mirrors the canonical scanner's list. */
const SINK_PATTERNS = [/\bfetch\s*\(/, /\bhttps?\.request\s*\(/, /\bcurl\b/];

function pluginLibFiles(): string[] {
  if (!fs.existsSync(PLUGIN_LIB)) return [];
  return fs
    .readdirSync(PLUGIN_LIB)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(PLUGIN_LIB, name));
}

describe('gstack-dsh plugin egress receipts', () => {
  test('every network sink under .dsh/plugin/lib records a receipt first', () => {
    const offenders: string[] = [];
    for (const file of pluginLibFiles()) {
      const source = fs.readFileSync(file, 'utf-8');
      const hitsSink = SINK_PATTERNS.some((pattern) => pattern.test(source));
      if (!hitsSink) continue;
      // egress-receipt.js IS the receipt writer; it spawns the bridge rather
      // than touching the network itself.
      if (path.basename(file) === 'egress-receipt.js') continue;
      if (!source.includes('writeEgressReceipt')) offenders.push(path.relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  test('jev.js writes the receipt before the fetch, not after', () => {
    const source = fs.readFileSync(path.join(PLUGIN_LIB, 'jev.js'), 'utf-8');
    const receiptAt = source.indexOf('writeEgressReceipt(');
    expect(receiptAt).toBeGreaterThan(-1);
    // The only fetch in the file; the receipt call must precede it in source order.
    const fetchAt = source.search(/\bfetch\s*\(/);
    expect(fetchAt).toBeGreaterThan(-1);
    expect(receiptAt).toBeLessThan(fetchAt);
  });

  test('the receipt bridge is fail-closed and names its repair', () => {
    const source = fs.readFileSync(path.join(PLUGIN_LIB, 'egress-receipt.js'), 'utf-8');
    expect(source).toContain('EGRESS_RECEIPT_FAILED');
    expect(source).toContain('GSTACK_DSH_EGRESS_HELPER'); // the override operator escape hatch
    expect(source).toContain('--payload-file'); // exact-bytes hashing, not a re-serialization
  });
});

describe('gstack-dsh plugin suite wiring', () => {
  test('the plugin tests are NOT in the bun TEST_ROOTS (bun skips dot-directories)', () => {
    for (const root of TEST_ROOTS) {
      expect(root).not.toContain('.dsh');
    }
  });

  test('package.json runs the plugin suite via node --test', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf-8'));
    expect(pkg.scripts['test:plugin']).toBe('node --test .dsh/plugin/test/');
    expect(pkg.scripts.test).toContain('test:plugin');
  });

  test('CI runs the plugin suite and the aggregate gate requires it', () => {
    const source = fs.readFileSync(WORKFLOW, 'utf-8');
    expect(source).toContain('bun run test:plugin');
    expect(source).toMatch(/plugin-node-tests:/);
    // Merge-blocking: the stable `free-tests` aggregate must need it and assert it.
    expect(source).toMatch(/needs:\s*\[[^\]]*plugin-node-tests[^\]]*\]/);
    expect(source).toContain('PLUGIN_TESTS_RESULT');
    expect(source).toMatch(/test "\$PLUGIN_TESTS_RESULT" = success/);
  });
});
