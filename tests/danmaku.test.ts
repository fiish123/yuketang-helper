import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DanmuDetector } from '../src/danmaku.ts';

function make(start = 1_000_000) {
  let clock = start;
  const d = new DanmuDetector({ windowMs: 60000, threshold: 8, minRepeat: 3, quietMs: 30000, maxPeakMs: 120000 }, () => clock);
  return { d, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

test('达到阈值触发一次，同一高峰不再触发', () => {
  const { d, tick } = make();
  const fired: any[] = [];
  for (let i = 0; i < 8; i++) { tick(500); const r = d.push('不是', 'u' + i); if (r?.action === 'trigger') fired.push(r); }
  assert.equal(fired.length, 1);
  assert.equal(fired[0].text, '不是');
  assert.equal(fired[0].count, 8);
  for (let i = 0; i < 10; i++) { tick(500); const r = d.push('不是', 'u' + i); if (r?.action === 'trigger') fired.push(r); }
  assert.equal(fired.length, 1);
});

test('安静 30 秒后结束高峰，新高峰可再次触发且窗口已清空', () => {
  const { d, tick } = make();
  const fired: any[] = [];
  for (let i = 0; i < 8; i++) { tick(500); const r = d.push('A', 'u'); if (r?.action === 'trigger') fired.push(r); }
  assert.equal(fired.length, 1);
  tick(31000);
  const first = d.push('B', 'u');
  assert.equal(first?.action, 'collect', '安静后的第一条应重新计数');
  for (let i = 0; i < 7; i++) { tick(500); const r = d.push('B', 'u'); if (r?.action === 'trigger') fired.push(r); }
  assert.equal(fired.length, 2);
  assert.equal(fired[1].text, 'B');
});

test('多文本时选重复次数最多的', () => {
  const { d, tick } = make();
  const fired: any[] = [];
  const seq = ['不是','不是','不是','是','是','不是','不是','不是'];
  seq.forEach((x, i) => { tick(500); const r = d.push(x, 'u' + i); if (r?.action === 'trigger') fired.push(r); });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].text, '不是');
  assert.equal(fired[0].count, 6);
});

test('都不重复时先等待，后续重复文本补发一次', () => {
  const { d, tick } = make();
  const acts: any[] = [];
  for (let i = 0; i < 8; i++) { tick(400); acts.push(d.push('msg' + i, 'u' + i)); }
  assert.ok(acts.some(x => x?.action === 'peak-wait'));
  for (let i = 0; i < 6; i++) { tick(400); acts.push(d.push('X', 'u' + i)); }
  const fired = acts.filter(x => x?.action === 'trigger');
  assert.equal(fired.length, 1);
  assert.equal(fired[0].text, 'X');
  assert.equal(fired[0].delayed, true);
});

test('排除自己发送的弹幕', () => {
  const { d, tick } = make();
  d.setSelfId('me');
  const fired = [];
  for (let i = 0; i < 8; i++) { tick(500); const r = d.push('我自己', 'me'); if (r?.action === 'trigger') fired.push(r); }
  assert.equal(fired.length, 0);
});

test('真实抓包回放只跟发一条', () => {
  const f = new URL('./fixtures/danmu_frames.json', import.meta.url);
  const frames: { ts: number; text: string; userid: string }[] = JSON.parse(fs.readFileSync(f, 'utf8'));
  frames.sort((a, b) => a.ts - b.ts);
  let now = 0;
  const d = new DanmuDetector({ windowMs: 60000, threshold: 8, minRepeat: 3, quietMs: 30000, maxPeakMs: 120000 }, () => now);
  const fired: any[] = [];
  for (const x of frames) { now = x.ts; const r = d.push(x.text, x.userid); if (r?.action === 'trigger') fired.push({ ...r, ts: x.ts }); }
  assert.equal(frames.length, 56);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].text, '不是');
});
