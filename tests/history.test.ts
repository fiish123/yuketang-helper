import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-history-'));
process.env.STATE_DIR = dir;

const {
  CLEAR_REQUEST_FILE,
  CLEAR_DONE_FILE,
  clearHistoryFiles,
  newClearRequest,
  readClearRequest,
  removeClearRequest,
  writeClearDone,
  writeClearRequest
} = await import('../src/history.ts');

after(() => fs.rmSync(dir, { recursive: true, force: true }));

function put(name: string, content = '{}'): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function seedAll(): void {
  for (const name of [
    'state.json', 'answers.json', 'submissions.jsonl', 'solver.jsonl',
    'danmu.jsonl', 'danmu_status.json', 'rollcall.jsonl', 'rollcall_status.json',
    'rollcall_ack.json', 'solve_control.json', 'watcher.log', 'presentation.json'
  ]) put(name);
  put('covers/pid.webp');
  for (const name of [
    'cookies.json', 'settings.json', 'classroom.json', 'login_qr.png', 'watcher_status.json'
  ]) put(name);
}

test('清空历史会删除题目、记录和封面，但保留登录与设置', () => {
  seedAll();
  clearHistoryFiles();
  for (const name of [
    'state.json', 'answers.json', 'submissions.jsonl', 'solver.jsonl',
    'danmu.jsonl', 'danmu_status.json', 'rollcall.jsonl', 'rollcall_status.json',
    'rollcall_ack.json', 'solve_control.json', 'watcher.log', 'presentation.json'
  ]) {
    assert.equal(fs.existsSync(path.join(dir, name)), false, name + ' 应被删除');
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, 'covers')), []);
  for (const name of [
    'cookies.json', 'settings.json', 'classroom.json', 'login_qr.png', 'watcher_status.json'
  ]) {
    assert.equal(fs.existsSync(path.join(dir, name)), true, name + ' 应保留');
  }
});

test('手动清空保留 presentation，但仍清空封面目录', () => {
  seedAll();
  clearHistoryFiles({ keepPresentation: true });
  assert.equal(fs.existsSync(path.join(dir, 'presentation.json')), true);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'covers')), []);
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
});

test('清空请求超过 TTL 后不再生效，清空标记读写正常', () => {
  removeClearRequest();
  const req = newClearRequest('switch', 'lesson-1', 'test');
  writeClearRequest(req);
  assert.equal(readClearRequest(req.ts + 1000)?.id, req.id);
  assert.equal(readClearRequest(req.ts + 61_000), null);
  writeClearDone({ id: req.id, ts: Date.now(), ok: true, mode: 'switch', source: 'test' });
  assert.equal(fs.existsSync(CLEAR_DONE_FILE), true);
  assert.equal(fs.existsSync(CLEAR_REQUEST_FILE), true);
  removeClearRequest();
  assert.equal(fs.existsSync(CLEAR_REQUEST_FILE), false);
});