'use strict';

const { Worker } = require('node:worker_threads');

function createAutoLearnWorkerRunner(options = {}) {
  const workerPath = options.workerPath;
  const optionsProvider = typeof options.optionsProvider === 'function'
    ? options.optionsProvider : () => ({});
  const workerFactory = typeof options.workerFactory === 'function'
    ? options.workerFactory : (filename, workerOptions) => new Worker(filename, workerOptions);
  const onMutation = typeof options.onMutation === 'function' ? options.onMutation : () => {};
  let queue = Promise.resolve();
  let deactivating = false;
  let deactivation = null;
  const jobs = new Set();
  const workers = new Set();

  function execute(operation, args) {
    if (deactivating) return Promise.reject(new Error('Auto Learn is deactivating'));
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = workerFactory(workerPath, {
          workerData: { options: optionsProvider(), operation, args },
        });
      } catch (error) {
        reject(error);
        return;
      }
      workers.add(worker);
      let settled = false;
      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value);
      };
      worker.once('message', (message) => {
        if (!message?.ok) {
          const error = new Error(message?.error?.message || 'Auto Learn worker failed');
          if (message?.error?.code) error.code = message.error.code;
          if (message?.error?.stack) error.stack = message.error.stack;
          settle(error);
          return;
        }
        try {
          onMutation(operation, message.result);
          settle(null, message.result);
        } catch (error) {
          settle(error);
        }
      });
      worker.once('error', (error) => settle(error));
      worker.once('exit', (code) => {
        workers.delete(worker);
        if (settled) return;
        settle(new Error(`Auto Learn worker exited with code ${code} without a result message`));
      });
    });
  }

  function run(operation, ...args) {
    if (deactivating) return Promise.reject(new Error('Auto Learn is deactivating'));
    const job = queue.then(() => execute(operation, args));
    queue = job.catch(() => undefined);
    jobs.add(job);
    job.then(() => jobs.delete(job), () => jobs.delete(job));
    return job;
  }

  function deactivate() {
    if (deactivation) return deactivation;
    deactivating = true;
    deactivation = (async () => {
      // A manager operation may be between policy writes. Drain authorized work
      // to its result so JS rollback remains available; queued work sees the
      // deactivating guard and never starts. Only completed workers that failed
      // to exit are safe to terminate after all job promises have settled.
      await Promise.allSettled([...jobs]);
      const lingering = [...workers];
      await Promise.allSettled(lingering.map((worker) =>
        typeof worker.terminate === 'function' ? worker.terminate() : undefined));
    })();
    return deactivation;
  }

  function stats() {
    return { deactivating, jobs: jobs.size, workers: workers.size };
  }

  return { run, deactivate, stats };
}

module.exports = { createAutoLearnWorkerRunner };
