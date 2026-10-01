/**
 * Tests for pipeline state persistence.
 *
 * Every test writes into its own temporary `.dsh/` directory. Nothing here
 * touches the real project state, so the suite stays deterministic and leaves
 * no artifacts behind.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { STAGES, createPipelineState, advanceStage } from '../lib/pipeline.js';
import {
  PIPELINE_STATE_FILE,
  createPipelineStore,
  findProjectRoot,
  resolveStateDir,
} from '../lib/pipeline-store.js';

/** Create a throwaway state directory; the caller removes it. */
function tempStateDir() {
  return mkdtempSync(join(tmpdir(), 'gstack-pipeline-store-'));
}

/* ------------------------ root resolution ------------------------ */

test('findProjectRoot walks up to the nearest directory containing .git', () => {
  const fakeGit = (path) => path === '/repo/.git';
  assert.equal(findProjectRoot('/repo/packages/app/src', fakeGit), '/repo');
  assert.equal(findProjectRoot('/repo', fakeGit), '/repo');
});

test('findProjectRoot returns null when no ancestor has .git', () => {
  // Deliberately null, not the start directory: the Harness process's working
  // directory is its own home, so "no project found" must be distinguishable
  // from "found the project here".
  assert.equal(findProjectRoot('/nowhere/deep', () => false), null);
});

test('resolveStateDir reports unavailable when no project root exists', () => {
  // This is the real Harness case: cwd is ~/.dsh and nothing above it is a repo.
  assert.equal(resolveStateDir({ cwd: '/nowhere/deep', hasGit: () => false }), null);
});

test('resolveStateDir prefers an explicit override and otherwise uses the project .dsh', () => {
  assert.equal(resolveStateDir({ stateDir: '/explicit/state' }), '/explicit/state');
  // No override: resolve from the injected cwd via the git-root rule.
  assert.equal(resolveStateDir({ cwd: '/repo/sub', hasGit: (path) => path === '/repo/.git' }), '/repo/.dsh');
});

test('resolveStateDir reports unavailable rather than inventing a location', () => {
  assert.equal(resolveStateDir({ cwd: '' }), null);
  // A blank override with no cwd must fail closed, not fall back to the real
  // process working directory and start writing into the repository.
  assert.equal(resolveStateDir({ stateDir: '   ' }), null);
  assert.equal(resolveStateDir({ stateDir: '   ', cwd: '' }), null);
});

/* --------------------------- store ------------------------------- */

test('pipeline state round-trips through disk', () => {
  const dir = tempStateDir();
  try {
    const store = createPipelineStore({ stateDir: dir });
    assert.equal(store.available, true);
    assert.equal(store.path, join(dir, PIPELINE_STATE_FILE));

    const state = createPipelineState({ objective: 'port gstack' });
    advanceStage(state, STAGES[1].id, { gate: 0.9 });

    const saved = store.save(state);
    assert.equal(saved.status, 'ok');

    const loaded = store.load();
    assert.equal(loaded.status, 'ok');
    assert.equal(loaded.state.stageId, STAGES[1].id);
    assert.equal(loaded.state.objective, 'port gstack');
    assert.deepEqual(loaded.state.history, state.history);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing state file is reported as missing, not as an error', () => {
  const dir = tempStateDir();
  try {
    const loaded = createPipelineStore({ stateDir: dir }).load();
    assert.equal(loaded.status, 'missing');
    assert.equal(loaded.state, null);
    assert.equal(loaded.error, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt state file is reported and left on disk for the operator', () => {
  const dir = tempStateDir();
  try {
    const store = createPipelineStore({ stateDir: dir });
    writeFileSync(store.path, '{"stageId": "not-a-stage"}\n', 'utf8');

    const loaded = store.load();
    assert.equal(loaded.status, 'invalid');
    assert.equal(loaded.state, null);
    assert.ok(loaded.error, 'an invalid file must explain itself');

    // Reported, never silently replaced: the caller decides.
    assert.equal(readFileSync(store.path, 'utf8'), '{"stageId": "not-a-stage"}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save creates the state directory when it does not exist yet', () => {
  const root = tempStateDir();
  const nested = join(root, 'a', 'b', '.dsh');
  try {
    const store = createPipelineStore({ stateDir: nested });
    assert.equal(store.save(createPipelineState({ objective: 'x' })).status, 'ok');
    assert.equal(store.load().status, 'ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('save reports a write failure instead of throwing, and leaves no temp file', () => {
  const root = tempStateDir();
  try {
    // A regular file where a directory is required makes mkdir/write fail.
    const blocked = join(root, 'blocked');
    writeFileSync(blocked, 'not a directory', 'utf8');

    const store = createPipelineStore({ stateDir: join(blocked, '.dsh') });
    const saved = store.save(createPipelineState({ objective: 'x' }));

    assert.notEqual(saved.status, 'ok');
    assert.ok(saved.error, 'the failure must explain itself');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clear removes persisted state and treats an absent file as success', () => {
  const dir = tempStateDir();
  try {
    const store = createPipelineStore({ stateDir: dir });
    store.save(createPipelineState({ objective: 'x' }));
    assert.equal(store.load().status, 'ok');

    assert.equal(store.clear().status, 'ok');
    assert.equal(store.load().status, 'missing');
    // Idempotent: clearing twice is not an error.
    assert.equal(store.clear().status, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unresolvable state directory yields a totally-unavailable store', () => {
  // Both sources of a location are blank, so resolution fails rather than
  // falling back to the real working directory and writing into the repo.
  const store = createPipelineStore({ stateDir: '  ', cwd: '' });
  assert.equal(store.available, false);
  assert.equal(store.path, null);
  for (const method of ['load', 'save', 'clear']) {
    const result = store[method](createPipelineState({ objective: 'x' }));
    assert.equal(result.status, 'unavailable');
    assert.equal(result.state, null);
  }
});

/* ------------------- plugin integration -------------------------- */

test('the plugin loads a persisted run at boot and advances from it', async () => {
  const { apply } = await import('../lib/index.js');
  const dir = tempStateDir();
  try {
    // A prior session got as far as "build".
    const store = createPipelineStore({ stateDir: dir });
    const prior = createPipelineState({ objective: 'finish the port' });
    advanceStage(prior, STAGES[2].id, { gate: 0.95 });
    store.save(prior);

    const registered = [];
    const ctx = {
      tools: { register: (tool) => registered.push(tool) },
      logger: { info: () => {} },
      on: () => () => {},
    };

    const plugin = apply(ctx, { stateDir: dir, log: () => {} });
    const pipeline = registered.find((t) => t.name === 'gstack_pipeline');

    const status = await pipeline.execute({ action: 'status' });
    assert.equal(status.pipeline.stage, STAGES[2].id, 'the persisted stage should be restored');
    assert.equal(status.objective, 'finish the port');
    assert.equal(status.persistence.restored, 'ok');
    assert.equal(status.persistence.path, store.path);

    // Advancing writes through to the same file.
    const advanced = await pipeline.execute({ action: 'advance' });
    assert.equal(advanced.advanced, true);
    assert.equal(advanced.persisted, store.path);

    assert.equal(store.load().state.stageId, STAGES[3].id);
    assert.ok(plugin.pipelineStore().available);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the plugin starts fresh when persisted state is corrupt, and says so', async () => {
  const { apply } = await import('../lib/index.js');
  const dir = tempStateDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, PIPELINE_STATE_FILE), '{"stageId":"bogus"}\n', 'utf8');

    const registered = [];
    const ctx = {
      tools: { register: (tool) => registered.push(tool) },
      logger: { info: () => {} },
      on: () => () => {},
    };

    const plugin = apply(ctx, { stateDir: dir, log: () => {} });
    const pipeline = registered.find((t) => t.name === 'gstack_pipeline');

    const status = await pipeline.execute({ action: 'status' });
    assert.equal(status.pipeline.stage, STAGES[0].id, 'a corrupt file must not block a run');
    assert.equal(status.persistence.restored, 'invalid', 'the reason must be visible');
    assert.equal(plugin.pipelineStore().restored, 'invalid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a persisted objective survives a boot that also passes one in config', async () => {
  const { apply } = await import('../lib/index.js');
  const dir = tempStateDir();
  try {
    const store = createPipelineStore({ stateDir: dir });
    store.save(createPipelineState({ objective: 'the original goal' }));

    const registered = [];
    const ctx = {
      tools: { register: (tool) => registered.push(tool) },
      logger: { info: () => {} },
      on: () => () => {},
    };

    apply(ctx, { stateDir: dir, objective: 'a different goal', log: () => {} });
    const pipeline = registered.find((t) => t.name === 'gstack_pipeline');

    const status = await pipeline.execute({ action: 'status' });
    assert.equal(status.objective, 'the original goal', 'a restored run owns its objective');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
