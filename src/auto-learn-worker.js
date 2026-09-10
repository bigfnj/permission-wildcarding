'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { createAutoLearnManager } = require('./auto-learn-manager');

function run(data) {
  const manager = createAutoLearnManager(data?.options || {});
  const operation = data?.operation;
  // `rebuildManagedHits` belongs here even though no UI path calls it yet: it is
  // the one remaining manager operation that both mutates state and does real
  // work (it re-reads the managed policy and re-assesses every candidate), so
  // omitting it left a caller two bad options — a worker that rejects the
  // operation, or an in-process call that blocks the extension host. The runner
  // fires onMutation for every operation, so the host's cached manager is
  // invalidated afterwards with no extra wiring.
  if (!['scan', 'apply', 'undo', 'setMode', 'rebuildManagedHits'].includes(operation)) {
    throw new Error(`Unsupported Auto Learn worker operation: ${operation}`);
  }
  const args = Array.isArray(data?.args) ? data.args : [];
  return manager[operation](...args);
}

if (parentPort) {
  try {
    parentPort.postMessage({ ok: true, result: run(workerData) });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: {
        message: error?.message || String(error),
        code: error?.code || null,
        stack: error?.stack || null,
      },
    });
  }
}

module.exports = { run };
