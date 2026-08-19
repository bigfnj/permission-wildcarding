'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createAutoLearnWorkerRunner } = require('../vscode-extension/autoLearnWorkerRunner');

class FakeWorker extends EventEmitter {
  constructor(start) {
    super();
    this.start = start;
    queueMicrotask(() => start(this));
  }

  terminate() {
    this.emit('exit', 1);
    return Promise.resolve(1);
  }
}

test('zero exit without a worker message is rejected', async () => {
  const runner = createAutoLearnWorkerRunner({
    workerPath: 'worker.js',
    workerFactory: () => new FakeWorker((worker) => worker.emit('exit', 0)),
  });
  await assert.rejects(runner.run('scan'), /code 0 without a result message/);
  await runner.deactivate();
});

test('worker mutations are serialized and invalidate after each result', async () => {
  let active = 0;
  let maximum = 0;
  const mutations = [];
  const runner = createAutoLearnWorkerRunner({
    workerPath: 'worker.js',
    optionsProvider: () => ({ mode: 'recommend' }),
    onMutation: (operation) => mutations.push(operation),
    workerFactory: (_filename, workerOptions) => new FakeWorker((worker) => {
      active += 1;
      maximum = Math.max(maximum, active);
      setImmediate(() => {
        active -= 1;
        worker.emit('message', { ok: true, result: workerOptions.workerData.operation });
        worker.emit('exit', 0);
      });
    }),
  });

  const results = await Promise.all([
    runner.run('scan'), runner.run('apply'), runner.run('undo'),
  ]);
  assert.deepEqual(results, ['scan', 'apply', 'undo']);
  assert.equal(maximum, 1);
  assert.deepEqual(mutations, ['scan', 'apply', 'undo']);
  await runner.deactivate();
});

test('deactivation drains active work before terminating a post-result lingering worker', async () => {
  let release;
  let terminated = false;
  const runner = createAutoLearnWorkerRunner({
    workerPath: 'worker.js',
    workerFactory: () => new FakeWorker((worker) => {
      release = () => worker.emit('message', { ok: true, result: 'finished' });
      worker.terminate = () => {
        terminated = true;
        worker.emit('exit', 0);
        return Promise.resolve(0);
      };
    }),
  });

  const job = runner.run('apply');
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = runner.deactivate();
  assert.equal(runner.stats().deactivating, true);
  await assert.rejects(runner.run('scan'), /deactivating/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(terminated, false, 'active policy work must not be interrupted');
  release();
  assert.equal(await job, 'finished');
  await stopping;
  assert.equal(terminated, true);
  assert.deepEqual(runner.stats(), { deactivating: true, jobs: 0, workers: 0 });
});

test('deactivation prevents an already queued operation from spawning another worker', async () => {
  let workersCreated = 0;
  let release;
  const runner = createAutoLearnWorkerRunner({
    workerPath: 'worker.js',
    workerFactory: () => {
      workersCreated += 1;
      return new FakeWorker((worker) => {
        release = () => worker.emit('message', { ok: true, result: 'finished' });
        worker.terminate = () => {
          worker.emit('exit', 0);
          return Promise.resolve(0);
        };
      });
    },
  });

  const active = runner.run('scan');
  const queued = runner.run('apply');
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = runner.deactivate();
  release();
  assert.equal(await active, 'finished');
  await assert.rejects(queued, /deactivating/);
  await stopping;
  assert.equal(workersCreated, 1);
});
