import fs from 'node:fs';
import path from 'node:path';
import { STATE, getSelectedLessonId, numEnv, readJson } from './config.ts';
import { checkin, api, fetchUserInfo } from './lessonClient.ts';
import { DanmuDetector } from './danmaku.ts';
import { abortAllSolves, beginSolve, solveWithRetry, SolveAbortedError, type SolveRun } from './solveRun.ts';
import { RollcallDetector } from './rollcall.ts';
import { clearHistoryFiles, readClearRequest, removeClearRequest, writeClearDone, type ClearRequest } from './history.ts';

const STATE_FILE = STATE + '/state.json';
const ANSWERS_FILE = STATE + '/answers.json';
const SUB_FILE = STATE + '/submissions.jsonl';
const SOLVER_LOG = STATE + '/solver.jsonl';
const HB_FILE = STATE + '/watcher_status.json';
const PRES_FILE = STATE + '/presentation.json';
const COVERS = STATE + '/covers';
const DANMU_FILE = STATE + '/danmu.jsonl';
const DANMU_STATUS = STATE + '/danmu_status.json';
const ROLLCALL_FILE = STATE + '/rollcall.jsonl';
const ROLLCALL_STATUS = STATE + '/rollcall_status.json';
const ROLLCALL_ACK = STATE + '/rollcall_ack.json';
fs.mkdirSync(COVERS, { recursive: true });

const AUTO = process.env.AUTO !== '0';
const AUTO_SOLVE = process.env.AUTO_SOLVE !== '0';
const MIN_DELAY_MS = numEnv('MIN_DELAY_MS', 40000);
const SOLVE_RETRIES = numEnv('SOLVE_RETRIES', 2);
const SUBMIT_RETRIES = numEnv('SUBMIT_RETRIES', 2);
const DANMU = process.env.DANMU !== '0';
const DANMU_SEND = process.env.DANMU_SEND !== '0';
const ROLLCALL = process.env.ROLLCALL !== '0';

const detector = new DanmuDetector({
  windowMs: numEnv('DANMU_WINDOW_MS', 60000),
  threshold: numEnv('DANMU_THRESHOLD', 8),
  minRepeat: numEnv('DANMU_MIN_REPEAT', 3),
  quietMs: numEnv('DANMU_QUIET_MS', 30000),
  maxPeakMs: numEnv('DANMU_MAX_PEAK_MS', 120000),
  maxLen: numEnv('DANMU_MAX_LEN', 50)
});
const rollDetector = new RollcallDetector({ name: '', userId: '', identityId: '' });
let rollAlertSeq = readJson<any>(ROLLCALL_STATUS, { alertSeq: 0 }).alertSeq || 0;

const RANK: Record<string, number> = { new: 0, failed: 1, pending: 1, historical: 2, submitted: 2 };
let state: any = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { seen: {}, lastTimeline: {} };
if (!state.seen) state.seen = {};
if (typeof state.lastTimeline === 'number') {
  const old = state.lastTimeline;
  state.lastTimeline = {};
  if (old > 0) state.lastTimeline[getSelectedLessonId()] = old;
}
if (!state.lastTimeline || typeof state.lastTimeline !== 'object') state.lastTimeline = {};
let answers: any = fs.existsSync(ANSWERS_FILE) ? JSON.parse(fs.readFileSync(ANSWERS_FILE, 'utf8')) : {};

let currentLesson = getSelectedLessonId();
let lessonToken = '';
let identityId = '';
let selfName = '';
let presId = '';
let slidesCache: any[] | null = null;
let baselinePending = false;
let generation = 0;
let ws: WebSocket | null = null;
let reconnectTimer: any = null;
let pingTimer: any = null;
let wsState = currentLesson ? 'closed' : 'no-lesson';
let lessonEnded = false;
let lessonEndedReason = '';
let lessonEndedAt = 0;
let lastHb = 0;
let connectStartedAt = Date.now();
let lastSwitchCheck = 0;

function log(o: Record<string, any>): void {
  const line = JSON.stringify({ ts: Date.now(), ...o });
  fs.appendFileSync(STATE + '/watcher.log', line + '\n');
  console.log(new Date().toLocaleTimeString('zh-CN'), JSON.stringify(o).slice(0, 300));
}

function timelineMap(raw: any): Record<string, number> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = Number(v) || 0;
    return out;
  }
  return {};
}
function lastTimelineFor(lessonId: string): number {
  return timelineMap(state.lastTimeline)[lessonId] || 0;
}
function setLastTimeline(lessonId: string, dt: number): void {
  const map = timelineMap(state.lastTimeline);
  map[lessonId] = Math.max(map[lessonId] || 0, dt || 0);
  state.lastTimeline = map;
}

function save(): void {
  let disk: any = {};
  try { disk = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* ignore */ }
  const merged: any = { lastTimeline: { ...timelineMap(disk.lastTimeline) }, seen: { ...(disk.seen || {}) }, lessonId: currentLesson };
  for (const [pid, cur] of Object.entries(state.seen)) {
    const old: any = merged.seen[pid];
    if (old && (RANK[old.status] || 0) > (RANK[(cur as any).status] || 0)) merged.seen[pid] = { ...(cur as any), ...old, cover: (cur as any).cover || old.cover, si: (cur as any).si ?? old.si, type: (cur as any).type ?? old.type };
    else merged.seen[pid] = cur;
  }
  for (const [k, v] of Object.entries(timelineMap(state.lastTimeline))) merged.lastTimeline[k] = Math.max(merged.lastTimeline[k] || 0, v);
  state = merged;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
}

function writePres(): void {
  if (presId) fs.writeFileSync(PRES_FILE, JSON.stringify({ lessonId: currentLesson, presentationId: presId, ts: Date.now() }, null, 1));
}
function setPres(id: string): void {
  if (!id || id === presId) return;
  presId = String(id); slidesCache = null; writePres(); hb(true); log({ kind: 'presentation', pres: presId });
}

async function loadSlides(): Promise<any[] | null> {
  if (slidesCache) return slidesCache;
  if (!presId) return null;
  const r = await api('/api/v3/lesson/presentation/fetch?presentation_id=' + presId, { lessonId: currentLesson });
  if (r.status !== 200) { log({ kind: 'presentation-fail', status: r.status, pres: presId }); return null; }
  slidesCache = r.json?.data?.slides || [];
  return slidesCache;
}

async function ensureCover(slide: any, pid: string): Promise<string | null> {
  for (const ext of ['.webp', '.png', '.jpg']) {
    const f = COVERS + '/' + pid + ext;
    if (fs.existsSync(f)) return f;
  }
  const url = slide.coverAlt || slide.cover;
  if (!url) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  const ext = ct.includes('jpeg') ? '.jpg' : ct.includes('webp') ? '.webp' : '.png';
  const f = COVERS + '/' + pid + ext;
  fs.writeFileSync(f, buf); return f;
}

function asMs(n: any): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v > 1e12 ? v : v * 1000;
}
function recentEvent(it: any): boolean {
  const dt = asMs(it && it.dt);
  if (!dt) return true;
  return dt >= Date.now() - 180000;
}

function pushTimestamp(pid: string, info: any): number {
  const dt = info && Number(info.dt);
  if (Number.isFinite(dt) && dt > 1e12) return dt;
  const seen = state.seen[pid] && state.seen[pid].firstSeen;
  return Number.isFinite(seen) ? seen : Date.now();
}

async function waitForMinDelay(pid: string, info: any, signal?: AbortSignal): Promise<boolean> {
  if (MIN_DELAY_MS <= 0) return true;
  const wait = pushTimestamp(pid, info) + MIN_DELAY_MS - Date.now();
  if (wait <= 0) return true;
  log({ kind: 'delay', problemId: pid, waitMs: Math.round(wait), minDelayMs: MIN_DELAY_MS });
  if (signal?.aborted) return false;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.round(wait));
    signal?.addEventListener('abort', finish, { once: true });
  });
  return !signal?.aborted;
}

async function submitWithRetry(pid: string, body: any): Promise<any> {
  let last: any = { status: 0, text: 'no attempt' };
  for (let attempt = 1; attempt <= SUBMIT_RETRIES + 1; attempt++) {
    try {
      const t = await checkin(currentLesson);
      if (t.ended) {
        endLesson('submit checkin ' + t.code + ' ' + (t.msg || 'LESSON_END'));
        return { status: t.status || 0, text: 'lesson ended', ended: true, attempts: attempt, noRetry: true };
      }
      if (!t.ok) { last = { status: t.status || 0, text: 'checkin failed' }; }
      else {
        const r = await api('/api/v3/lesson/problem/answer', { method: 'POST', body: { ...body, dt: body.dt || Date.now() }, lessonId: currentLesson });
        const ok = r.status === 200 && r.json && r.json.code === 0;
        if (ok) return { ...r, attempts: attempt };
        last = { status: r.status, text: r.text.slice(0, 300) };
        const code = r.json && r.json.code;
        if (code === 50013 || r.status === 403 || /PROBLEM_NOT_FOUND|已结束|finished/i.test(r.text)) return { ...last, attempts: attempt, noRetry: true };
      }
    } catch (e: any) { last = { status: 0, text: String(e.message || e).slice(0, 200) }; }
    if (attempt <= SUBMIT_RETRIES) await new Promise(r => setTimeout(r, 1200 * attempt));
  }
  return { ...last, attempts: SUBMIT_RETRIES + 1 };
}

async function submitProblem(pid: string, info: any): Promise<void> {
  let ans = answers[pid];
  let run: SolveRun | null = null;
  try {
    if ((!ans || !Array.isArray(ans.result)) && AUTO_SOLVE && info.cover) {
      // 自动解题与手动重试走同一条 solveRun 流程；新的解题请求会强制中断旧的。
      run = beginSolve(pid, 'watcher');
      log({ kind: 'solve-start', problemId: pid, cover: info.cover, maxAttempts: SOLVE_RETRIES + 1, runId: run.runId });
      try {
        const { s, attempt, last } = await solveWithRetry(info.cover, pid, run.signal, SOLVE_RETRIES + 1, (n, failure) => {
          if (failure.kind === 'parse-fail') log({ kind: 'solve-fail', problemId: pid, attempt: n, raw: String(failure.raw || '').slice(0, 100) });
          else log({ kind: 'solve-error', problemId: pid, attempt: n, msg: String(failure.msg || '').slice(0, 150) });
        });
        if (!run.isCurrent()) { log({ kind: 'solve-aborted', problemId: pid, runId: run.runId, note: 'superseded' }); return; }
        if (s && s.ok) {
          ans = { result: s.answers, reason: s.reason, source: 'llm', ts: Date.now() };
          answers[pid] = ans;
          fs.writeFileSync(ANSWERS_FILE + '.tmp', JSON.stringify(answers, null, 1));
          fs.renameSync(ANSWERS_FILE + '.tmp', ANSWERS_FILE);
          fs.appendFileSync(SOLVER_LOG, JSON.stringify({ ts: Date.now(), problemId: pid, answers: s.answers, reason: s.reason, ms: s.ms, usage: s.usage, attempt }) + '\n');
          log({ kind: 'solved', problemId: pid, answers: s.answers, ms: s.ms, attempt, reason: String(s.reason || '').slice(0, 80) });
        } else {
          fs.appendFileSync(SOLVER_LOG, JSON.stringify({ ts: Date.now(), problemId: pid, error: last, raw: String(last && last.raw || '').slice(0, 500) }) + '\n');
          log({ kind: 'solve-giveup', problemId: pid, attempts: SOLVE_RETRIES + 1, last: JSON.stringify(last).slice(0, 120) });
        }
      } catch (e: any) {
        if (e instanceof SolveAbortedError || run.signal.aborted) { log({ kind: 'solve-aborted', problemId: pid, runId: run.runId, note: 'aborted' }); return; }
        log({ kind: 'solve-error', problemId: pid, msg: String(e.message || e).slice(0, 150) });
      }
    }
    if (!ans || !Array.isArray(ans.result)) { log({ kind: 'pending', problemId: pid, si: info.si, note: 'no answer' }); state.seen[pid].status = 'pending'; save(); return; }
    if (run && !run.isCurrent()) { log({ kind: 'solve-aborted', problemId: pid, runId: run.runId, note: 'superseded before submit' }); return; }
    if (!await waitForMinDelay(pid, info, run?.signal)) { log({ kind: 'solve-aborted', problemId: pid, runId: run?.runId, note: 'aborted during delay' }); return; }
    if (run && !run.isCurrent()) { log({ kind: 'solve-aborted', problemId: pid, runId: run.runId, note: 'superseded after delay' }); return; }
    const body = { problemId: pid, problemType: ans.type ?? info.type ?? 2, dt: Date.now(), result: ans.result };
    const r = await submitWithRetry(pid, body);
    if (r.ended) {
      state.seen[pid].status = 'pending';
      state.seen[pid].resp = '课堂已结束，未提交';
      save(); log({ kind: 'submit-skipped', problemId: pid, reason: 'lesson-ended' });
      return;
    }
    const ok = r.status === 200 && String(r.text || '').includes('"code":0');
    const rec = { problemId: pid, si: info.si, result: ans.result, status: r.status, resp: String(r.text || '').slice(0, 300), attempts: r.attempts || 1, ts: Date.now() };
    fs.appendFileSync(SUB_FILE, JSON.stringify(rec) + '\n');
    const checkinFail = String(r.text || '') === 'checkin failed';
    state.seen[pid].status = ok ? 'submitted' : (checkinFail ? 'pending' : 'failed');
    state.seen[pid].result = ans.result; state.seen[pid].resp = String(r.text || '').slice(0, 300);
    save(); log({ kind: 'submit', ...rec });
  } finally {
    run?.end();
  }
}

function writeDanmuStatus(extra: Record<string, any> = {}): void {
  try {
    const snap = detector.snapshot();
    fs.writeFileSync(DANMU_STATUS, JSON.stringify({ ts: Date.now(), enabled: DANMU, sendEnabled: DANMU_SEND, ...snap, ...extra }, null, 1));
  } catch { /* ignore */ }
}

async function sendDanmu(message: string): Promise<any> {
  const body = { lessonId: currentLesson, target: '', userName: '', message, extra: '', requiredCensor: false, wordCloud: true, showStatus: true, fromStart: '50' };
  const r = await api('/api/v3/lesson/danmu/send', { method: 'POST', body, lessonId: currentLesson });
  return { ok: r.status === 200 && r.json && r.json.code === 0, status: r.status, code: r.json && r.json.code, text: r.text };
}

async function onDanmu(d: any): Promise<void> {
  try {
    const text = String(d.danmu || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const r = detector.push(text, d.userid);
    fs.appendFileSync(DANMU_FILE, JSON.stringify({ ts: Date.now(), kind: 'recv', op: d.op, text: text.slice(0, 120), userid: String(d.userid || ''), danmuid: d.danmuid || null, action: r ? r.action : null, window: r ? r.window : 0 }) + '\n');
    if (r && r.action === 'trigger') {
      log({ kind: 'danmu-trigger', text: r.text, count: r.count, window: r.window, send: DANMU_SEND });
      if (DANMU_SEND) {
        const res = await sendDanmu(String(r.text || ''));
        if (res.ok) log({ kind: 'danmu-sent', text: r.text, count: r.count });
        else log({ kind: 'danmu-send-fail', text: r.text, status: res.status, resp: String(res.text || '').slice(0, 160) });
        fs.appendFileSync(DANMU_FILE, JSON.stringify({ ts: Date.now(), kind: 'send', text: r.text, count: r.count, ok: res.ok, status: res.status, resp: String(res.text || '').slice(0, 300) }) + '\n');
      }
    } else if (r && r.action === 'peak-wait') {
      log({ kind: 'danmu-peak', text: r.text, count: r.count, note: '高峰已开始，等待更集中的文本' });
    }
    writeDanmuStatus();
  } catch (e: any) { log({ kind: 'danmu-error', msg: String(e.message || e).slice(0, 150) }); }
}

function writeRollcallStatus(extra: Record<string, any> = {}): void {
  const prev = readJson<any>(ROLLCALL_ACK, { ackSeq: 0 });
  fs.writeFileSync(ROLLCALL_STATUS, JSON.stringify({
    ts: Date.now(), enabled: ROLLCALL, self: rollDetector.self,
    total: rollDetector.total, hits: rollDetector.hits, misses: rollDetector.misses,
    alertSeq: rollAlertSeq, ackSeq: prev.ackSeq || 0,
    last: rollDetector.last, ...extra
  }, null, 2));
}

function onRollcall(v: any, source: string): void {
  if (!ROLLCALL) return;
  try {
    const ev = rollDetector.inspect(v, source);
    if (!ev) return;
    const { raw, ...plain } = ev;
    fs.appendFileSync(ROLLCALL_FILE, JSON.stringify(plain) + '\n');
    if (ev.hit) {
      rollAlertSeq++;
      log({ kind: 'rollcall-hit', title: ev.title, picked: ev.picked, self: ev.selfName });
      process.stdout.write('\x07');
    } else {
      log({ kind: 'rollcall-miss', title: ev.title, picked: ev.picked });
    }
    writeRollcallStatus();
  } catch (e: any) { log({ kind: 'rollcall-error', msg: String(e.message || e).slice(0, 150) }); }
}

// 清空当前课堂历史：先中止本进程解题，再删磁盘记录，最后重置内存状态。
// 必须由 watcher 执行，否则它下一次 save() 会把旧内存状态写回。
function applyHistoryClear(req: ClearRequest): void {
  const mode = req.mode;
  try {
    abortAllSolves();
    clearHistoryFiles({ keepPresentation: mode === 'manual' });
    state = { seen: {}, lastTimeline: {} };
    answers = {};
    inflight.clear();
    slidesCache = null;
    baselinePending = true;
    if (mode !== 'manual') presId = '';

    detector.endPeak('history-clear');
    detector.setSelfId(identityId);
    rollDetector.seen.clear();
    rollDetector.total = 0;
    rollDetector.hits = 0;
    rollDetector.misses = 0;
    rollDetector.last = null;
    rollAlertSeq = 0;

    writeDanmuStatus();
    writeRollcallStatus();
    hb(true);
    log({ kind: 'history-cleared', mode, lessonId: req.lessonId || currentLesson, requestId: req.id });
    writeClearDone({ id: req.id, ts: Date.now(), ok: true, mode, lessonId: req.lessonId || currentLesson, source: 'watcher' });
  } catch (e: any) {
    log({ kind: 'history-clear-error', requestId: req.id, msg: String(e.message || e).slice(0, 180) });
    writeClearDone({ id: req.id, ts: Date.now(), ok: false, mode, lessonId: req.lessonId || currentLesson, error: String(e.message || e).slice(0, 200), source: 'watcher' });
  } finally {
    removeClearRequest();
  }
}
function maybeClearHistory(): void {
  const req = readClearRequest();
  if (req) applyHistoryClear(req);
}

const inflight = new Set<string>();
async function onProblem(pid: string, info: any): Promise<void> {
  if (!pid || inflight.has(pid)) return;
  if (state.seen[pid] && state.seen[pid].status === 'submitted') return;
  inflight.add(pid);
  try { await onProblemInner(pid, info); }
  catch (e: any) { log({ kind: 'problem-error', problemId: pid, msg: String(e.message || e).slice(0, 150) }); }
  finally { inflight.delete(pid); }
}

async function onProblemInner(pid: string, info: any): Promise<void> {
  if (info.pres) setPres(info.pres);
  const slides = await loadSlides();
  const slide = slides && slides.find((s: any) => s.problem && s.problem.problemId === pid);
  const problem = slide && slide.problem;
  const slideIndex = slide && slide.index != null ? slide.index : info.si;
  const result = problem && Array.isArray(problem.result) && problem.result.length ? problem.result : null;
  const sendTime = Number(problem && problem.sendTime) || 0;
  const baseline = lastTimelineFor(currentLesson);
  const firstSeen = state.seen[pid] && state.seen[pid].firstSeen ? state.seen[pid].firstSeen : Date.now();
  const type = problem?.problemType ?? info.type;
  const options = problem?.options?.length;
  const oldCover = state.seen[pid] && state.seen[pid].cover;

  // 老师翻到含旧题的页面时，slidenav.unlockedproblem 会把历史题重新带出来；
  // 以 presentation 里的 result/sendTime 为准，不能把它们当成新题。
  if (result) {
    state.seen[pid] = { problemId: pid, si: slideIndex, dt: sendTime || info.dt, type, options, status: 'submitted', result, firstSeen, cover: oldCover, historical: true };
    save(); log({ kind: 'already-answered', problemId: pid, si: slideIndex, result });
    return;
  }
  if (sendTime > 0 && baseline > 0 && sendTime <= baseline) {
    state.seen[pid] = { problemId: pid, si: slideIndex, dt: sendTime, type, options, status: 'historical', firstSeen, cover: oldCover, historical: true };
    save(); log({ kind: 'problem-historical', problemId: pid, si: slideIndex, sendTime, baseline });
    return;
  }

  let cover: string | null = null;
  if (slide) cover = await ensureCover(slide, pid);
  const meta = { si: slideIndex, dt: info.dt || sendTime, type, options, cover };
  state.seen[pid] = { problemId: pid, ...meta, status: 'new', firstSeen };
  save(); log({ kind: 'NEW_PROBLEM', problemId: pid, si: meta.si, type: meta.type, cover });
  if (AUTO) await submitProblem(pid, meta);
}

function hb(force = false): void {
  const now = Date.now();
  if (!force && now - lastHb < 5000) return;
  lastHb = now;
  try {
    fs.writeFileSync(HB_FILE, JSON.stringify({
      ts: now, ws: wsState, lessonId: currentLesson, presId, minDelayMs: MIN_DELAY_MS, rollcall: ROLLCALL,
      selected: !!currentLesson, ended: lessonEnded, endedReason: lessonEndedReason, endedAt: lessonEndedAt || null
    }));
  } catch { /* ignore */ }
}

async function connect(): Promise<void> {
  const gen = ++generation;
  try { await connectInner(gen); }
  catch (e: any) {
    if (gen !== generation) return;
    log({ kind: 'connect-fail', msg: String(e.message || e).slice(0, 200) });
    clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 10000);
  }
}

function closeWs(nextState = 'closed'): void {
  generation++;
  clearTimeout(reconnectTimer); clearInterval(pingTimer);
  try { ws?.close(); } catch { /* ignore */ }
  ws = null; wsState = nextState;
}

// 课堂结束：停止 WS、重连、心跳轮询和自动重试；保留本地选课监听，
// 用户在 WebUI 选中新课堂后 maybeSwitchLesson 会重新 connect。
function endLesson(reason: string): void {
  if (lessonEnded && wsState === 'ended') return;
  lessonEnded = true;
  lessonEndedReason = String(reason || '').slice(0, 200);
  lessonEndedAt = Date.now();
  closeWs('ended');
  hb(true);
  log({ kind: 'lesson-ended', lessonId: currentLesson, reason: lessonEndedReason, note: '已停止课堂轮询和自动重连，等待选择新课堂' });
}

async function connectInner(gen: number): Promise<void> {
  if (gen !== generation) return;
  connectStartedAt = Date.now();
  log({ kind: 'config', lessonId: currentLesson, presId, minDelayMs: MIN_DELAY_MS, auto: AUTO, autoSolve: AUTO_SOLVE, danmu: DANMU, danmuSend: DANMU_SEND, danmuThreshold: detector.opts.threshold, danmuWindowMs: detector.opts.windowMs, rollcall: ROLLCALL });
  const t = await checkin(currentLesson);
  if (gen !== generation) return;
  if (t.ended) {
    endLesson('checkin ' + t.code + ' ' + (t.msg || 'LESSON_END'));
    return;
  }
  if (!t.ok) throw new Error('checkin failed: ' + t.status + (t.code ? ' code=' + t.code : '') + (t.msg ? ' ' + t.msg : ''));
  lessonToken = t.lessonToken;
  const payload = JSON.parse(Buffer.from(lessonToken.split('.')[1], 'base64url').toString());
  identityId = String(payload.identityId || '');
  try {
    const u = await fetchUserInfo();
    selfName = u.name || selfName;
    rollDetector.setSelf({ name: selfName, userId: u.userId, identityId });
  } catch {
    rollDetector.setSelf({ identityId });
  }
  detector.setSelfId(identityId);
  writeDanmuStatus(); writeRollcallStatus();

  ws = new WebSocket('wss://changjiang.yuketang.cn/wsapp/');
  const sock = ws;
  sock.addEventListener('open', () => {
    if (gen !== generation) { try { sock.close(); } catch { /* ignore */ } return; }
    wsState = 'open'; hb(true); log({ kind: 'ws-open', lessonId: currentLesson });
    sock.send(JSON.stringify({ op: 'hello', userid: identityId, role: 'student', auth: lessonToken, lessonid: currentLesson }));
    setTimeout(() => { try { sock.send(JSON.stringify({ op: 'fetchtimeline', lessonid: currentLesson, msgid: Date.now() })); } catch { /* ignore */ } }, 500);
    pingTimer = setInterval(() => {
      try { if (sock.readyState === 1) { sock.send(JSON.stringify({ op: 'ping', lessonid: currentLesson })); hb(false); } } catch { /* ignore */ }
    }, 20000);
  });
  sock.addEventListener('message', async (ev: MessageEvent) => {
    if (gen !== generation) return;
    let d: any; try { d = JSON.parse(String(ev.data)); } catch { return; }
    hb(false);
    if (d.op === 'hello' || d.op === 'fetchtimeline') log({ kind: 'msg', op: d.op, items: (d.timeline || []).length });

    if (DANMU && (d.op === 'newdanmu' || d.op === 'systemdanmu')) await onDanmu(d);

    if (d.timeline) {
      for (const it of d.timeline) {
        if (it.pres) setPres(it.pres);
      }
      const isInitial = baselinePending || lastTimelineFor(currentLesson) === 0;
      if (isInitial) {
        let maxDt = lastTimelineFor(currentLesson);
        for (const it of d.timeline) if (Number(it.dt) > maxDt) maxDt = Number(it.dt);
        setLastTimeline(currentLesson, maxDt);
        baselinePending = false; state.lessonId = currentLesson; save();
        log({ kind: 'timeline-baseline', lessonId: currentLesson, dt: maxDt, items: d.timeline.length });
        for (const it of d.timeline) {
          if (it.type === 'event' && recentEvent(it)) onRollcall(it, 'timeline-initial');
        }
      } else {
        for (const it of d.timeline) {
          if (it.type === 'problem' && it.dt > lastTimelineFor(currentLesson)) {
            await onProblem(it.prob, { si: it.si, dt: it.dt, pres: it.pres });
            setLastTimeline(currentLesson, it.dt); save();
          } else if (it.type === 'event' && recentEvent(it)) {
            onRollcall(it, 'timeline');
          }
        }
      }
    }

    if (d.op === 'unlockproblem' && d.problem) await onProblem(d.problem.prob, { si: d.problem.si, dt: d.problem.dt, pres: d.problem.pres });
    if (d.op === 'probleminfo' && d.problemid) await onProblem(d.problemid, { dt: d.dt });
    if (d.op === 'slidenav') {
      if (d.slide?.pres) setPres(d.slide.pres);
      if (d.unlockedproblem) for (const pid of d.unlockedproblem) { if (!state.seen[pid]) await onProblem(pid, { si: d.slide && d.slide.si, dt: d.slide && d.slide.dt }); }
    }
    if (d.op !== 'hello' && d.op !== 'fetchtimeline' && d.op !== 'newdanmu' && d.op !== 'systemdanmu') {
      onRollcall(d, 'ws');
    }
  });
  sock.addEventListener('close', (e: CloseEvent) => {
    if (gen !== generation) return;
    wsState = 'closed'; hb(true); log({ kind: 'ws-close', code: e.code });
    clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 3000);
  });
  sock.addEventListener('error', (e: any) => { if (gen === generation) log({ kind: 'ws-error', msg: String(e.message || e) }); });
}

function maybeSwitchLesson(): void {
  const next = getSelectedLessonId();
  if (!next) {
    if (currentLesson || ws || wsState !== 'no-lesson') {
      log({ kind: 'lesson-cleared', from: currentLesson, note: '未选择课堂，停止课堂连接与轮询' });
      closeWs('no-lesson');
      currentLesson = ''; lessonToken = ''; identityId = '';
      presId = ''; slidesCache = null; baselinePending = true;
      lessonEnded = false; lessonEndedReason = ''; lessonEndedAt = 0;
      hb(true);
    }
    return;
  }
  if (next === currentLesson) return;
  log({ kind: 'lesson-switch', from: currentLesson, to: next });
  closeWs('closed');
  currentLesson = next;
  lessonEnded = false; lessonEndedReason = ''; lessonEndedAt = 0;
  presId = ''; slidesCache = null; baselinePending = true;
  detector.endPeak('lesson-switch'); writeDanmuStatus();
  hb(true);
  connect();
}

if (process.platform !== 'win32') {
  // Windows 不支持 SIGUSR1；Windows 上重启 watcher 即可重新读取 answers.json
  process.on('SIGUSR1', () => { try { answers = JSON.parse(fs.readFileSync(ANSWERS_FILE, 'utf8')); log({ kind: 'answers-reloaded', count: Object.keys(answers).length }); } catch { /* ignore */ } });
}

maybeClearHistory();
setInterval(maybeClearHistory, 500);
setInterval(maybeSwitchLesson, 3000);
setInterval(() => hb(false), 15000);
if (!currentLesson) log({ kind: 'no-lesson', note: '等待在 WebUI 选择正在上课的课堂' });
else connect();
