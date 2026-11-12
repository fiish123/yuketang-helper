import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE, readJson, writeJson } from './config.ts';

// server 与 watcher 分进程。清空历史由 watcher 执行（它持有内存状态），
// server 只写请求文件并等待 watcher 的完成标记，避免旧内存状态被 save() 写回。
export const CLEAR_REQUEST_FILE = path.join(STATE, 'clear_request.json');
export const CLEAR_DONE_FILE = path.join(STATE, 'clear_done.json');
export const CLEAR_REQUEST_TTL_MS = 60000;

export type ClearMode = 'manual' | 'switch';

export interface ClearRequest {
  id: string;
  ts: number;
  mode: ClearMode;
  lessonId?: string;
  requestedBy?: string;
}

export interface ClearDone {
  id: string;
  ts: number;
  ok: boolean;
  mode?: ClearMode;
  lessonId?: string;
  error?: string;
  source?: string;
}

const STATE_FILE = path.join(STATE, 'state.json');
const ANSWERS_FILE = path.join(STATE, 'answers.json');
const SUB_FILE = path.join(STATE, 'submissions.jsonl');
const SOLVER_LOG = path.join(STATE, 'solver.jsonl');
const PRES_FILE = path.join(STATE, 'presentation.json');
const COVERS = path.join(STATE, 'covers');
const DANMU_FILE = path.join(STATE, 'danmu.jsonl');
const DANMU_STATUS = path.join(STATE, 'danmu_status.json');
const ROLLCALL_FILE = path.join(STATE, 'rollcall.jsonl');
const ROLLCALL_STATUS = path.join(STATE, 'rollcall_status.json');
const ROLLCALL_ACK = path.join(STATE, 'rollcall_ack.json');
const SOLVE_CONTROL = path.join(STATE, 'solve_control.json');
const WATCHER_LOG = path.join(STATE, 'watcher.log');

export function newClearRequest(mode: ClearMode, lessonId = '', requestedBy = 'server'): ClearRequest {
  return { id: crypto.randomUUID(), ts: Date.now(), mode, lessonId: lessonId || undefined, requestedBy };
}

export function readClearRequest(now = Date.now()): ClearRequest | null {
  const r = readJson<ClearRequest | null>(CLEAR_REQUEST_FILE, null);
  if (!r || !r.id || !r.ts || !r.mode) return null;
  if (now - r.ts > CLEAR_REQUEST_TTL_MS) return null;
  return r;
}

export function writeClearRequest(req: ClearRequest): void {
  writeJson(CLEAR_REQUEST_FILE, req);
}

export function removeClearRequest(): void {
  try { fs.rmSync(CLEAR_REQUEST_FILE, { force: true }); } catch { /* ignore */ }
}

export function readClearDone(): ClearDone | null {
  return readJson<ClearDone | null>(CLEAR_DONE_FILE, null);
}

export function writeClearDone(done: ClearDone): void {
  writeJson(CLEAR_DONE_FILE, done);
}

export function clearHistoryFiles(opts: { keepPresentation?: boolean } = {}): void {
  const files = [
    STATE_FILE,
    ANSWERS_FILE,
    SUB_FILE,
    SOLVER_LOG,
    DANMU_FILE,
    DANMU_STATUS,
    ROLLCALL_FILE,
    ROLLCALL_STATUS,
    ROLLCALL_ACK,
    SOLVE_CONTROL,
    WATCHER_LOG
  ];
  if (!opts.keepPresentation) files.push(PRES_FILE);
  for (const f of files) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(COVERS, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.mkdirSync(COVERS, { recursive: true }); } catch { /* ignore */ }
}
