import http from 'node:http';
import fs from 'node:fs';
import { STATE, DASHBOARD_HTML, PORT, getSelectedLesson, getSettings, saveSettings, maskKey, readJson, numEnv } from './config.ts';
import { checkin, api, fetchLessons } from './lessonClient.ts';
import { abortAllSolves, beginSolve, solveWithRetry, SolveAbortedError } from './solveRun.ts';
import { clearHistoryFiles, newClearRequest, readClearDone, removeClearRequest, writeClearDone, writeClearRequest, type ClearMode } from './history.ts';
import { statusPayload, logsPayload, startLogin, loginStatus, qrFile, checkLogin } from './monitor.ts';

const stateFile = STATE + '/state.json';
const answersFile = STATE + '/answers.json';
const subFile = STATE + '/submissions.jsonl';
const danmuFile = STATE + '/danmu.jsonl';
const danmuStatusFile = STATE + '/danmu_status.json';
const rollcallFile = STATE + '/rollcall.jsonl';
const rollcallStatusFile = STATE + '/rollcall_status.json';
const rollcallAckFile = STATE + '/rollcall_ack.json';
const presFile = STATE + '/presentation.json';

const readState = (): any => { try { const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (!s.seen) s.seen = {}; return s; } catch { return { seen: {}, lastTimeline: {} }; } };
const writeState = (s: any): void => fs.writeFileSync(stateFile, JSON.stringify(s, null, 1));
const readAnswers = (): any => { try { return JSON.parse(fs.readFileSync(answersFile, 'utf8')); } catch { return {}; } };

const readDanmuStatus = (): any => { try { return JSON.parse(fs.readFileSync(danmuStatusFile, 'utf8')); } catch { return null; } };
function readDanmuRecent(n: number): any[] {
  try {
    const lines = fs.readFileSync(danmuFile, 'utf8').trim().split('\n').filter(Boolean).slice(-n);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
const readRollcallStatus = (): any => { try { return JSON.parse(fs.readFileSync(rollcallStatusFile, 'utf8')); } catch { return null; } };
function readRollcallRecent(n: number): any[] {
  try {
    const lines = fs.readFileSync(rollcallFile, 'utf8').trim().split('\n').filter(Boolean).slice(-n);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

async function sendDanmu(message: string): Promise<any> {
  const lessonId = getSelectedLesson().lessonId;
  await checkin(lessonId);
  const body = { lessonId, target: '', userName: '', message, extra: '', requiredCensor: false, wordCloud: true, showStatus: true, fromStart: '50' };
  const r = await api('/api/v3/lesson/danmu/send', { method: 'POST', body, lessonId });
  const rec = { ts: Date.now(), kind: 'manual-send', text: message, status: r.status, ok: r.status === 200 && r.json && r.json.code === 0, resp: String(r.text || '').slice(0, 300) };
  fs.appendFileSync(danmuFile, JSON.stringify(rec) + '\n');
  return rec;
}

function presentationId(): string {
  const p = readJson<any>(presFile, null);
  const lesson = getSelectedLesson().lessonId;
  if (p && p.presentationId && (!p.lessonId || p.lessonId === lesson)) return String(p.presentationId);
  return String(process.env.PRESENTATION_ID || '');
}

let slidesCache: { pres: string; slides: any[] } | null = null;
async function ensureCover(id: string): Promise<string | null> {
  for (const ext of ['.webp', '.png', '.jpg']) {
    const f = STATE + '/covers/' + id + ext;
    if (fs.existsSync(f)) return f;
  }
  const pres = presentationId();
  if (!pres) return null;
  if (!slidesCache || slidesCache.pres !== pres) {
    await checkin(getSelectedLesson().lessonId);
    const r = await api('/api/v3/lesson/presentation/fetch?presentation_id=' + pres);
    if (r.status !== 200) return null;
    slidesCache = { pres, slides: r.json?.data?.slides || [] };
  }
  const s = slidesCache.slides.find((x: any) => x.problem && x.problem.problemId === id);
  if (!s) return null;
  const url = s.coverAlt || s.cover;
  if (!url) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  const ext = ct.includes('jpeg') ? '.jpg' : ct.includes('webp') ? '.webp' : '.png';
  const f = STATE + '/covers/' + id + ext;
  fs.writeFileSync(f, buf); return f;
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// 让 watcher 执行清空（它持有内存状态），server 等完成标记；
// 如果 watcher 根本没启动（心跳过期），server 直接清磁盘，避免手动清空不可用。
async function clearHistoryRequest(mode: ClearMode, lessonId: string): Promise<any> {
  abortAllSolves();
  const req = newClearRequest(mode, lessonId, 'server');
  writeClearRequest(req);
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    const done = readClearDone();
    if (done && done.id === req.id) {
      if (!done.ok) return { ok: false, error: done.error || '清空失败', requestId: req.id };
      slidesCache = null;
      return { ok: true, cleared: true, source: done.source || 'watcher', requestId: req.id };
    }
    await sleep(100);
  }
  const hb = readJson<any>(STATE + '/watcher_status.json', null);
  const age = hb && hb.ts ? Date.now() - Number(hb.ts) : Infinity;
  if (age > 30000) {
    try {
      clearHistoryFiles({ keepPresentation: mode === 'manual' });
      writeClearDone({ id: req.id, ts: Date.now(), ok: true, mode, lessonId, source: 'server-fallback' });
      removeClearRequest();
      slidesCache = null;
      return { ok: true, cleared: true, source: 'server-fallback', requestId: req.id };
    } catch (e: any) {
      return { ok: false, error: String(e.message || e).slice(0, 200), requestId: req.id };
    }
  }
  return { ok: false, pending: true, error: 'watcher 暂未响应，请稍后重试', requestId: req.id };
}

async function waitMinDelay(problemId: string, minDelayMs: number): Promise<number> {
  if (!Number.isFinite(minDelayMs) || minDelayMs <= 0) return 0;
  const st = readState(); const p = st.seen[problemId] || {};
  const ts = Number(p.dt) > 1e12 ? Number(p.dt) : (p.firstSeen || Date.now());
  const wait = ts + minDelayMs - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, Math.round(wait)));
  return Math.max(0, Math.round(wait));
}

function json(res: http.ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  res.end(JSON.stringify(obj));
}

async function submit(problemId: string, result: string[], problemType: number, dt?: number): Promise<any> {
  const lessonId = getSelectedLesson().lessonId;
  await checkin(lessonId);
  const body = { problemId, problemType, dt: dt || Date.now(), result };
  const r = await api('/api/v3/lesson/problem/answer', { method: 'POST', body, lessonId });
  const rec = { ts: Date.now(), problemId, result, status: r.status, resp: r.text.slice(0, 500) };
  fs.appendFileSync(subFile, JSON.stringify(rec) + '\n');
  return rec;
}

async function solveProblem(problemId: string, outerSignal?: AbortSignal): Promise<any> {
  const cover = await ensureCover(problemId);
  if (!cover) return { ok: false, error: 'no cover（还没有 presentation；请确认 watcher 已连上课堂）' };
  // 正常解题与手动重试共用同一条路径；开始新解题会中止同题的旧解题。
  const run = beginSolve(problemId, 'server');
  const signal = outerSignal ? AbortSignal.any([run.signal, outerSignal]) : run.signal;
  try {
    const { s, attempt, last } = await solveWithRetry(cover, problemId, signal, numEnv('SOLVE_RETRIES', 2) + 1);
    if (signal.aborted) return { ok: false, aborted: true, error: '解题已被新的请求中断', runId: run.runId };
    if (!s) return { ok: false, error: 'solve failed', raw: String(last?.raw || last?.msg || '').slice(0, 300), runId: run.runId };
    return { ...s, attempt, runId: run.runId };
  } catch (e: any) {
    if (e instanceof SolveAbortedError || signal.aborted) return { ok: false, aborted: true, error: '解题已被新的请求中断', runId: run.runId };
    return { ok: false, error: String(e?.message || e).slice(0, 300), runId: run.runId };
  } finally {
    run.end();
  }
}

async function autoAnswer(problemId: string, minDelayMs = 40000): Promise<any> {
  const st = readState(); const info = st.seen[problemId] || {};
  const s = await solveProblem(problemId);
  if (!s.ok) return { ok: false, error: 'solve failed', raw: String(s.raw || '').slice(0, 300) };
  const waited = await waitMinDelay(problemId, minDelayMs);
  const rec = await submit(problemId, s.answers, info.type ?? 2);
  rec.waitedMs = waited;
  const ans = readAnswers(); ans[problemId] = { result: s.answers, reason: s.reason, source: 'llm', ts: Date.now() };
  fs.writeFileSync(answersFile, JSON.stringify(ans, null, 1));
  if (st.seen[problemId]) { st.seen[problemId].status = (rec.status === 200 && rec.resp.includes('"code":0')) ? 'submitted' : 'failed'; st.seen[problemId].result = s.answers; writeState(st); }
  return { ok: true, answers: s.answers, reason: s.reason, ms: s.ms, submit: rec };
}

function saveClassroomCache(lessons: any[]): void {
  fs.writeFileSync(STATE + '/classroom.json', JSON.stringify({ ts: Date.now(), lessons }, null, 1));
}

const srv = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
  const u = new URL(req.url || '/', 'http://x');
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  try {
    if (u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(DASHBOARD_HTML));
    }
    if (u.pathname === '/health') {
      const st = readState();
      return json(res, 200, { ok: true, lesson: getSelectedLesson(), presentationId: presentationId(), seen: Object.keys(st.seen || {}).length, time: Date.now() });
    }
    if (u.pathname === '/problems') {
      const st = readState();
      const RANK: Record<string, number> = { new: 0, pending: 0, failed: 1, submitted: 2, old: 3 };
      const arr = Object.values(st.seen || {}).sort((a: any, b: any) => {
        const ra = RANK[a.status] === undefined ? 9 : RANK[a.status], rb = RANK[b.status] === undefined ? 9 : RANK[b.status];
        if (ra !== rb) return ra - rb;
        return ((b.dt || b.firstSeen || 0) - (a.dt || a.firstSeen || 0));
      });
      return json(res, 200, arr);
    }
    if (u.pathname === '/pending') { const st = readState(); return json(res, 200, Object.values(st.seen || {}).filter((p: any) => p.status !== 'submitted' && p.status !== 'old')); }
    if (u.pathname === '/problem') { const st = readState(); const p = st.seen[u.searchParams.get('id') || '']; return p ? json(res, 200, p) : json(res, 404, { error: 'not found' }); }
    if (u.pathname.startsWith('/cover/')) {
      const id = u.pathname.split('/').pop() || '';
      const f = await ensureCover(id);
      if (!f) return json(res, 404, { error: 'no cover', hint: '请在 WebUI 选择课堂并等待 watcher 连上' });
      const ext = f.slice(f.lastIndexOf('.'));
      res.writeHead(200, { 'Content-Type': ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(f));
    }
    if (u.pathname === '/answer' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      const o = JSON.parse(body || '{}');
      if (!o.problemId || !Array.isArray(o.result)) return json(res, 400, { error: 'problemId and result[] required' });
      const st = readState(); const info = st.seen[o.problemId] || {};
      const rec = await submit(o.problemId, o.result, o.problemType ?? info.type ?? 2, o.dt);
      if (st.seen[o.problemId]) { st.seen[o.problemId].status = (rec.status === 200 && rec.resp.includes('"code":0')) ? 'submitted' : 'failed'; st.seen[o.problemId].result = o.result; writeState(st); }
      return json(res, 200, rec);
    }
    if ((u.pathname === '/solve' || u.pathname === '/auto') && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      const o = JSON.parse(body || '{}'); const id = o.problemId || u.searchParams.get('id');
      if (!id) return json(res, 400, { error: 'problemId required' });
      const clientAbort = new AbortController();
      req.on('aborted', () => clientAbort.abort());
      res.on('close', () => { if (!res.writableEnded) clientAbort.abort(); });
      const out = u.pathname === '/solve' ? await solveProblem(id, clientAbort.signal) : await autoAnswer(id, o.minDelayMs);
      return json(res, 200, out);
    }
    if (u.pathname === '/status') return json(res, 200, await statusPayload());
    if (u.pathname === '/logs') { const n = Math.min(300, Number(u.searchParams.get('n')) || 60); return json(res, 200, logsPayload(n)); }
    if (u.pathname === '/settings') {
      const s = getSettings();
      return json(res, 200, { apiKeySet: !!s.apiKey, apiKeyMasked: maskKey(s.apiKey), model: s.model || process.env.DS_MODEL || 'deepseek-flash', lesson: getSelectedLesson() });
    }
    if (u.pathname === '/settings/api-key' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      const o = JSON.parse(body || '{}');
      const key = String(o.apiKey || '').trim();
      if (key && key.length < 10) return json(res, 400, { error: 'API Key 长度异常' });
      saveSettings({ apiKey: key });
      const s = getSettings();
      return json(res, 200, { ok: true, apiKeySet: !!s.apiKey, apiKeyMasked: maskKey(s.apiKey) });
    }
    if (u.pathname === '/lessons') {
      try {
        const lessons = await fetchLessons();
        saveClassroomCache(lessons);
        return json(res, 200, { lessons, selected: getSelectedLesson() });
      } catch (e: any) {
        return json(res, 502, { error: String(e.message || e) });
      }
    }
    if (u.pathname === '/history/clear' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      const o = JSON.parse(body || '{}');
      const mode: ClearMode = o.mode === 'switch' ? 'switch' : 'manual';
      const lessonId = String(o.lessonId || getSelectedLesson().lessonId || '');
      return json(res, 200, await clearHistoryRequest(mode, lessonId));
    }
    if (u.pathname === '/lesson/select' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      const o = JSON.parse(body || '{}');
      const id = String(o.lessonId || '');
      if (!id) return json(res, 400, { error: 'lessonId required' });
      let lessons: any[] = [];
      try { lessons = await fetchLessons(); } catch (e: any) { return json(res, 502, { error: '获取课堂列表失败: ' + String(e.message || e) }); }
      const hit = lessons.find((x: any) => String(x.lessonId) === id);
      if (!hit) return json(res, 400, { error: '该课堂不在进行中的课堂列表里（可能已下课）' });
      const s = saveSettings({ lessonId: id, lessonName: String(hit.classroomName || ''), classroomId: String(hit.classroomId || ''), classroomName: String(hit.classroomName || ''), selectedAt: Date.now() });
      fs.appendFileSync(STATE + '/watcher.log', JSON.stringify({ ts: Date.now(), kind: 'lesson-selected', lessonId: id, classroomName: hit.classroomName }) + '\n');
      return json(res, 200, { ok: true, lesson: { lessonId: s.lessonId, lessonName: s.lessonName } });
    }
    if (u.pathname === '/login/status') { const l = await checkLogin(); return json(res, 200, { login: l, session: loginStatus() }); }
    if (u.pathname === '/login/start' || u.pathname === '/login/qr') {
      const s = await startLogin(u.searchParams.get('force') === '1');
      const l = await checkLogin();
      return json(res, 200, { login: l, session: s, qr: (s && s.status === 'waiting') ? ('/qr.png?v=' + encodeURIComponent(s.token || '')) : null });
    }
    if (u.pathname === '/qr.png') {
      const f = qrFile();
      if (!f) return json(res, 404, { error: 'no qr' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store, max-age=0' });
      return res.end(fs.readFileSync(f));
    }
    if (u.pathname === '/danmu') { const n = Math.min(100, Number(u.searchParams.get('n')) || 30); return json(res, 200, { enabled: true, status: readDanmuStatus(), recent: readDanmuRecent(n) }); }
    if (u.pathname === '/danmu/status') return json(res, 200, readDanmuStatus() || { enabled: false });
    if (u.pathname === '/danmu/send' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      const o = JSON.parse(body || '{}');
      const msg = String(o.message || '').replace(/\s+/g, ' ').trim().slice(0, 50);
      if (!msg) return json(res, 400, { error: 'message required' });
      return json(res, 200, await sendDanmu(msg));
    }
    if (u.pathname === '/rollcall') { const n = Math.min(100, Number(u.searchParams.get('n')) || 30); return json(res, 200, { status: readRollcallStatus(), recent: readRollcallRecent(n) }); }
    if (u.pathname === '/rollcall/status') return json(res, 200, readRollcallStatus() || { enabled: false });
    if (u.pathname === '/rollcall/ack' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      const o = JSON.parse(body || '{}');
      const seq = Number(o.seq) || readRollcallStatus()?.alertSeq || 0;
      fs.writeFileSync(rollcallAckFile, JSON.stringify({ ackSeq: seq, ts: Date.now() }, null, 1));
      return json(res, 200, { ok: true, ackSeq: seq });
    }
    if (u.pathname === '/answers') return json(res, 200, readAnswers());
    return json(res, 404, { error: 'not found' });
  } catch (e: any) { return json(res, 500, { error: String(e.message || e) }); }
});

srv.listen(PORT, '127.0.0.1', () => console.log('answer-api listening on http://127.0.0.1:' + PORT));
