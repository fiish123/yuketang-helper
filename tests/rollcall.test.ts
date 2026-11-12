import test from 'node:test';
import assert from 'node:assert/strict';
import { RollcallDetector } from '../src/rollcall.ts';

const self = { name: '张三', userId: '10000001', identityId: '20000002' };

test('RANDOM_PICK 事件点中自己', () => {
  const d = new RollcallDetector(self);
  const ev = d.inspect({ type: 'event', code: 'RANDOM_PICK', title: '随机点名选中：张三', dt: 100 }, 'timeline');
  assert.ok(ev);
  assert.equal(ev.hit, true);
  assert.equal(ev.picked, '张三');
  assert.equal(d.hits, 1);
});

test('RANDOM_PICK 未点中自己', () => {
  const d = new RollcallDetector(self);
  const ev = d.inspect({ type: 'event', code: 'RANDOM_PICK', title: '随机点名选中：李四', dt: 101 }, 'timeline');
  assert.ok(ev);
  assert.equal(ev.hit, false);
  assert.equal(d.misses, 1);
});

test('同一帧只处理一次', () => {
  const d = new RollcallDetector(self);
  const frame = { type: 'event', code: 'RANDOM_PICK', title: '随机点名选中：张三', dt: 102 };
  assert.ok(d.inspect(frame));
  assert.equal(d.inspect(frame), null);
  assert.equal(d.total, 1);
});

test('嵌套 data 中的点名帧', () => {
  const d = new RollcallDetector(self);
  const ev = d.inspect({ op: 'lesson_event', data: { type: 'event', code: 'RANDOM_PICK', title: '随机点名选中：张三', dt: 103 } }, 'ws');
  assert.ok(ev);
  assert.equal(ev.hit, true);
});

test('独立 newrollcall 帧按姓名命中', () => {
  const d = new RollcallDetector(self);
  const ev = d.inspect({ op: 'newrollcall', name: '张三' }, 'ws');
  assert.ok(ev);
  assert.equal(ev.hit, true);
});

test('按 userId 命中', () => {
  const d = new RollcallDetector(self);
  const ev = d.inspect({ code: 'RANDOM_PICK', replace: ['10000001'] }, 'ws');
  assert.ok(ev);
  assert.equal(ev.hit, true);
});

test('普通弹幕不应当成点名', () => {
  const d = new RollcallDetector(self);
  assert.equal(d.inspect({ op: 'newdanmu', danmu: '张三' }, 'ws'), null);
  assert.equal(d.total, 0);
});

test('setSelf 保留未提供字段', () => {
  const d = new RollcallDetector({ name: '', userId: 'u1', identityId: 'i1' });
  d.setSelf({ name: '王五' });
  assert.equal(d.self.name, '王五');
  assert.equal(d.self.userId, 'u1');
  assert.equal(d.self.identityId, 'i1');
});
