import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-solve-run-'));
process.env.STATE_DIR = dir;
const { beginSolve, readSolveControl, solveControlFile } = await import('../src/solveRun.ts');

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('同一道题开始新解题会强制中断旧解题', () => {
  const first = beginSolve('test-problem', 'server');
  assert.equal(first.isCurrent(), true);
  const second = beginSolve('test-problem', 'watcher');
  try {
    assert.equal(first.signal.aborted, true);
    assert.equal(first.isCurrent(), false);
    assert.equal(second.isCurrent(), true);
    first.end();
    // 旧 run 结束不能删除新 run 的控制记录
    assert.equal(second.isCurrent(), true);
    assert.equal(readSolveControl()['test-problem']?.runId, second.runId);
  } finally {
    second.end();
  }
  assert.equal(readSolveControl()['test-problem'], undefined);
});

test('外部进程写入新 run 时，当前解题会被中止', async () => {
  const run = beginSolve('external-test', 'server');
  try {
    const all = readSolveControl();
    all['external-test'] = { runId: 'another-process-run', owner: 'watcher', pid: 1, startedAt: Date.now() };
    fs.writeFileSync(solveControlFile(), JSON.stringify(all));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(run.signal.aborted, true);
    assert.equal(run.isCurrent(), false);
  } finally {
    run.end();
  }
});
