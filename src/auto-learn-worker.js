'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { createAutoLearnManager } = require('./auto-learn-manager');

function run(data) {
  const manager = createAutoLearnManager(data?.options || {});
  const operation = data?.operation;
  if (!['scan', 'apply', 'undo', 'setMode'].includes(operation)) {
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
