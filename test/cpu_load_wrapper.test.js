'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const wrapper = path.join(__dirname, '..', 'scripts', 'under-cpu-load.sh');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function launch(cpuSeconds, command) {
  const child = spawn(wrapper, ['1', String(cpuSeconds), '--', ...command], {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  return {
    child,
    async workerPid() {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const match = stderr.match(/cpu-load workers: (\d+)/);
        if (match) return Number(match[1]);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail(`wrapper did not report a worker PID; stderr=${JSON.stringify(stderr)}`);
    }
  };
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive(pid)) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return !alive(pid);
}

test('under-cpu-load removes workers when the command finishes', async () => {
  const run = launch(5, [process.execPath, '-e', 'setTimeout(() => {}, 100)']);
  const pid = await run.workerPid();
  const [code] = await new Promise((resolve, reject) => {
    run.child.once('error', reject);
    run.child.once('exit', (...args) => resolve(args));
  });
  assert.equal(code, 0);
  assert.equal(await waitForExit(pid, 1000), true, `worker ${pid} survived normal cleanup`);
});

test('under-cpu-load workers self-terminate after an untrappable wrapper death', async t => {
  const run = launch(1, [process.execPath, '-e', 'setTimeout(() => {}, 2000)']);
  const pid = await run.workerPid();
  t.after(() => { if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  run.child.kill('SIGKILL');
  assert.equal(await waitForExit(pid, 5000), true, `worker ${pid} outlived its CPU limit`);
});
