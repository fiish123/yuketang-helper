// 登录状态、watcher 状态、日志、二维码登录会话
import fs from 'node:fs';
import { BASE, COOKIE_FILE, STATE, getSelectedLesson, getSettings, maskKey } from './config.ts';
import QRCode from 'qrcode';

const QR_FILE = STATE + '/login_qr.png';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const MIN_DELAY_MS = Number.isFinite(Number(process.env.MIN_DELAY_MS)) ? Number(process.env.MIN_DELAY_MS) : 40000;

function readJson<T>(f: string, def: T): T { try { return JSON.parse(fs.readFileSync(f, 'utf8')) as T; } catch { return def; } }
function tailJsonl(f: string, n: number): any[] {
  try {
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-n);
    const out: any[] = [];
    for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* ignore */ } }
    return out;
  } catch { return []; }
}

export function cookies(): any[] { const a = readJson<any>(COOKIE_FILE, []); return Array.isArray(a) ? a : []; }
function cookieHeader(): string { return cookies().map(c => c.name + '=' + c.value).join('; '); }

let loginCache: { ts: number; data: any } = { ts: 0, data: null };
export async function checkLogin(force = false): Promise<any> {
  if (!force && loginCache.data && Date.now() - loginCache.ts < 8000) return loginCache.data;
  const ck = cookies();
  if (!ck.some(c => c.name === 'sessionid')) {
    loginCache = { ts: Date.now(), data: { ok: false, reason: 'no-session' } }; return loginCache.data;
  }
  try {
    const r = await fetch(BASE + '/v2/api/web/userinfo', {
      headers: { 'User-Agent': UA, Cookie: cookieHeader(), Accept: 'application/json, text/plain, */*', 'x-client': 'web, h5', xtbz: 'ykt' },
      signal: AbortSignal.timeout(15000)
    });
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { /* ignore */ }
    let ok = false, name = '', uid = '';
    if (r.status === 200 && j && j.data) {
      const d = Array.isArray(j.data) ? j.data[0] : j.data;
      if (d && (d.user_id || d.UserID || d.name)) { ok = true; name = d.name || ''; uid = String(d.user_id || d.UserID || ''); }
    }
    loginCache = { ts: Date.now(), data: { ok, name, uid, status: r.status } };
  } catch (e: any) {
    loginCache = { ts: Date.now(), data: { ok: false, reason: String(e.message || e).slice(0, 100) } };
  }
  return loginCache.data;
}

function parseSetCookie(resp: Response, jar: Map<string, any>): void {
  const list = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
  for (const sc of list) {
    const parts = sc.split(';'); const pair = parts.shift() || ''; const i = pair.indexOf('=');
    if (i < 0) continue;
    const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
    const c: any = { name, value, domain: 'changjiang.yuketang.cn', path: '/' };
    for (const a of parts) {
      const kv = a.split('='); const k = (kv[0] || '').trim().toLowerCase(); const v = (kv.slice(1).join('=') || '').trim();
      if (k === 'domain' && v) c.domain = v; else if (k === 'path' && v) c.path = v;
      else if (k === 'max-age' && v) c.expires = Math.floor(Date.now() / 1000) + Number(v);
    }
    jar.set(name, c);
  }
}

async function req(jar: Map<string, any>, path: string, opt: { method?: string; body?: any; headers?: Record<string, string> } = {}): Promise<{ status: number; text: string }> {
  const h: Record<string, string> = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Xt-Agent': 'h5', xtbz: 'ykt', 'x-client': 'web, h5', Origin: BASE, Referer: BASE + '/web' };
  if (opt.headers) Object.assign(h, opt.headers);
  const c = [...jar.values()].map((x: any) => x.name + '=' + x.value).join('; '); if (c) h.Cookie = c;
  const r = await fetch(BASE + path, {
    method: opt.method || 'GET',
    headers: h,
    body: opt.body === undefined ? undefined : (typeof opt.body === 'string' ? opt.body : JSON.stringify(opt.body)),
    signal: AbortSignal.timeout(20000)
  });
  parseSetCookie(r, jar);
  return { status: r.status, text: await r.text() };
}

async function makeQr(content: string, tag: string): Promise<string> {
  await QRCode.toFile(QR_FILE, content, { width: 520, margin: 1 });
  fs.writeFileSync(QR_FILE + '.tag', String(tag), 'utf8');
  return QR_FILE;
}

let loginSess: any = null;
function snap(): any {
  if (!loginSess) return null;
  return { status: loginSess.status, token: loginSess.token, ageMs: Date.now() - loginSess.created, user: loginSess.user, error: loginSess.error };
}
export function loginStatus(): any { return snap(); }
export function qrFile(): string | null { return loginSess && loginSess.status === 'waiting' ? QR_FILE : null; }

export async function startLogin(force = false): Promise<any> {
  if (!force && loginSess && loginSess.status === 'waiting' && Date.now() - loginSess.created < 280000) return snap();
  const jar = new Map<string, any>();
  const sess: any = { jar, created: Date.now(), status: 'waiting', token: null, user: null, error: null };
  loginSess = sess;
  try {
    await req(jar, '/web');
    const pre = await req(jar, '/api/v3/user/login/app-web-pre-info');
    const d = (JSON.parse(pre.text).data) || {};
    sess.token = d.token;
    await makeQr(d.qrContent, sess.token || String(Date.now()));
    pollLogin(sess).catch((e: any) => { sess.status = 'error'; sess.error = String(e.message || e).slice(0, 150); });
  } catch (e: any) { sess.status = 'error'; sess.error = String(e.message || e).slice(0, 150); }
  return snap();
}

async function pollLogin(sess: any): Promise<void> {
  while (sess.status === 'waiting' && Date.now() - sess.created < 300000) {
    const r = await req(sess.jar, '/api/v3/user/login/app-web-login', { method: 'POST', body: { token: sess.token }, headers: { 'Content-Type': 'application/json;charset=UTF-8' } });
    let j: any = null; try { j = JSON.parse(r.text); } catch { /* ignore */ }
    if (j && j.code === 0 && j.data && j.data.Auth) {
      const csrf = sess.jar.get('csrftoken')?.value || '';
      await req(sess.jar, '/pc/web_login', {
        method: 'POST',
        body: JSON.stringify({ UserID: j.data.UserID, Auth: j.data.Auth }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': csrf, 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/plain' }
      });
      const ui = await req(sess.jar, '/v2/api/web/userinfo');
      const arr = [...sess.jar.values()];
      if (arr.some((c: any) => c.name === 'sessionid') && ui.status === 200) {
        fs.writeFileSync(COOKIE_FILE + '.tmp', JSON.stringify(arr, null, 1));
        fs.renameSync(COOKIE_FILE + '.tmp', COOKIE_FILE);
        sess.user = { name: j.data.Name, id: j.data.UserID };
        sess.status = 'ok'; loginCache = { ts: 0, data: null };
        fs.appendFileSync(STATE + '/login.log', JSON.stringify({ ts: Date.now(), event: 'login-ok', user: j.data.Name, id: j.data.UserID, cookies: arr.length }) + '\n');
      } else { sess.status = 'error'; sess.error = 'no sessionid / userinfo ' + (ui.status || ''); }
      return;
    }
    const msg = (j && (j.msg || j.error)) || r.text || '';
    if (/过期|expire|invalid/i.test(msg)) {
      const pre = await req(sess.jar, '/api/v3/user/login/app-web-pre-info');
      const d = (JSON.parse(pre.text).data) || {};
      sess.token = d.token; await makeQr(d.qrContent, sess.token || String(Date.now()));
      fs.appendFileSync(STATE + '/login.log', JSON.stringify({ ts: Date.now(), event: 'qr-refresh' }) + '\n');
    }
    await new Promise(res => setTimeout(res, 1500));
  }
  if (sess.status === 'waiting') sess.status = 'timeout';
}

export async function statusPayload(): Promise<any> {
  const st = readJson<any>(STATE + '/state.json', { seen: {} });
  const list = Object.values(st.seen || {}) as any[];
  const counts: any = { total: list.length };
  for (const p of list) counts[p.status] = (counts[p.status] || 0) + 1;
  const hb = readJson<any>(STATE + '/watcher_status.json', null);
  const login = await checkLogin();
  const sess = snap();
  const settings = getSettings();
  return {
    ts: Date.now(),
    login,
    watcher: hb ? Object.assign({}, hb, { ageMs: Date.now() - (hb.ts || 0) }) : { ws: 'unknown', ageMs: null },
    watcherLogAgeMs: (() => { try { return Date.now() - fs.statSync(STATE + '/watcher.log').mtimeMs; } catch { return null; } })(),
    session: sess,
    counts,
    config: { minDelayMs: MIN_DELAY_MS, autoSolve: process.env.AUTO_SOLVE !== '0', auto: process.env.AUTO !== '0' },
    settings: { apiKeySet: !!settings.apiKey, apiKeyMasked: maskKey(settings.apiKey), model: settings.model || process.env.DS_MODEL || 'deepseek-flash' },
    lesson: getSelectedLesson(),
    lastEvent: tailJsonl(STATE + '/watcher.log', 1)[0] || null,
    submissions: tailJsonl(STATE + '/submissions.jsonl', 6).reverse(),
    solver: tailJsonl(STATE + '/solver.jsonl', 6).reverse(),
    lessons: readJson<any>(STATE + '/classroom.json', null)
  };
}

export function logsPayload(n = 60): any[] { return tailJsonl(STATE + '/watcher.log', n); }
