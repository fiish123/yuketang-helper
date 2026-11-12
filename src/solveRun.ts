import fs from 'node:fs';
import path from 'node:path';
import { STATE, numEnv, readJson, writeJson } from './config.ts';
import { solve, type SolveResult } from './solver.ts';

// 跨进程解题协调：server 和 watcher 共用同一份控制文件。
// 任何一方发起新解题，都会让旧解题的 AbortSignal 中止；最新请求胜出。
const CONTROL_FILE = path.join(STATE, 'solve_control.json');
const POLL_MS = 250;

export type SolveOwner = 'server' | 'watcher';

interface ControlEntry {
  runId: string;
  owner: SolveOwner;
  pid: number;
  startedAt: number;
}

interface ActiveRun {
  problemId: string;
  runId: string;
  owner: SolveOwner;
  controller: AbortController;
  timer: NodeJS.Timeout | null;
}

const active = new Map<string, ActiveRun>();

export class SolveAbortedError extends Error {
  readonly code = 'SOLVE_ABORTED';
  constructor(message = '解题已被新的请求中断') {
    super(message);
    this.name = 'SolveAbortedError';
  }
}

function readControl(): Record<string, ControlEntry> {
  return readJson<Record<string, ControlEntry>>(CONTROL_FILE, {});
}

function writeControl(all: Record<string, ControlEntry>): void {
  try { writeJson(CONTROL_FILE, all); } catch { /* 控制文件写失败时仍保留进程内取消能力 */ }
}

function stopTimer(run: ActiveRun): void {
  if (run.timer) { clearInterval(run.timer); run.timer = null; }
}

export interface SolveRun {
  problemId: string;
  runId: string;
  owner: SolveOwner;
  signal: AbortSignal;
  isCurrent(): boolean;
  end(): void;
}

export function beginSolve(problemId: string, owner: SolveOwner): SolveRun {
  const previous = active.get(problemId);
  if (previous) {
    previous.controller.abort();
    stopTimer(previous);
  }

  const runId = owner + '-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const controller = new AbortController();
  const run: ActiveRun = { problemId, runId, owner, controller, timer: null };
  active.set(problemId, run);

  const all = readControl();
  all[problemId] = { runId, owner, pid: process.pid, startedAt: Date.now() };
  writeControl(all);

  run.timer = setInterval(() => {
    if (controller.signal.aborted) { stopTimer(run); return; }
    const row = readControl()[problemId];
    if (!row || row.runId !== runId) {
      controller.abort();
      stopTimer(run);
    }
  }, POLL_MS);

  return {
    problemId,
    runId,
    owner,
    signal: controller.signal,
    isCurrent(): boolean {
      const row = readControl()[problemId];
      return !!row && row.runId === runId;
    },
    end(): void {
      stopTimer(run);
      if (active.get(problemId)?.runId === runId) active.delete(problemId);
      const now = readControl();
      if (now[problemId]?.runId === runId) {
        delete now[problemId];
        writeControl(now);
      }
    }
  };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new SolveAbortedError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new SolveAbortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface SolveAttemptsResult {
  s: SolveResult | null;
  attempt?: number;
  last?: any;
}

// 正常解题与手动重试共用这一条路径：可重试、可被新的解题请求中断。
// deadlineMs 覆盖所有重试的总耗时；默认 120 秒，避免 3 次重试拖到 6 分钟。
export async function solveWithRetry(
  cover: string,
  problemId: string,
  signal: AbortSignal,
  attempts: number,
  onFail?: (attempt: number, failure: any) => void,
  opts: { deadlineMs?: number } = {}
): Promise<SolveAttemptsResult> {
  let last: any = null;
  const max = Math.max(1, Math.floor(attempts));
  const deadlineMs = Math.max(1000, Number(opts.deadlineMs) || numEnv('SOLVE_DEADLINE_MS', 120000));
  const deadline = Date.now() + deadlineMs;
  for (let attempt = 1; attempt <= max; attempt++) {
    if (signal.aborted) throw new SolveAbortedError();
    const remaining = deadline - Date.now();
    if (remaining <= 250) {
      last = { kind: 'timeout', msg: '解题总时长超过 ' + Math.round(deadlineMs / 1000) + ' 秒', ms: deadlineMs, attempt: attempt - 1 };
      onFail?.(attempt, last);
      break;
    }
    try {
      const s = await solve(cover, { signal, timeoutMs: Math.min(120000, remaining) });
      if (s.ok) return { s, attempt };
      last = { kind: 'parse-fail', raw: s.raw, ms: s.ms, attempt };
      onFail?.(attempt, last);
    } catch (e: any) {
      if (signal.aborted || e?.name === 'AbortError' || e instanceof SolveAbortedError) {
        throw new SolveAbortedError();
      }
      last = { kind: 'error', msg: String(e?.message || e).slice(0, 150), attempt };
      onFail?.(attempt, last);
      if (/未配置 DeepSeek API Key|API Key/i.test(last.msg)) break;
      if (/解题超时|超时|timeout/i.test(last.msg)) break;
    }
    if (attempt < max) {
      const wait = Math.min(1500 * attempt, Math.max(0, deadline - Date.now()));
      if (wait <= 0) break;
      await abortableDelay(wait, signal);
    }
  }
  return { s: null, last };
}

export function readSolveControl(): Record<string, ControlEntry> {
  return readControl();
}

export function solveControlFile(): string {
  return CONTROL_FILE;
}

export function cleanupSolveControl(): void {
  try { if (fs.existsSync(CONTROL_FILE)) fs.unlinkSync(CONTROL_FILE); } catch { /* ignore */ }
}

// 清空历史时中止本进程内所有解题；控制文件由 clearHistoryFiles 删除，
// 其他进程的 solveRun 轮询发现记录消失后也会自行中止。
export function abortAllSolves(): void {
  for (const run of active.values()) {
    run.controller.abort();
    stopTimer(run);
  }
  active.clear();
  cleanupSolveControl();
}
