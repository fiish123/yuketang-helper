import fs from 'node:fs';
import { BASE, COOKIE_FILE, getSelectedLessonId } from './config.ts';

export interface ApiResult {
  status: number;
  setAuth: boolean;
  json: any;
  text: string;
}

export interface LessonInfo {
  classroomId: string;
  classroomName: string;
  courseId: string;
  courseName: string;
  lessonId: string;
  role: number;
  openTeacher?: boolean;
  [key: string]: unknown;
}

export function getCookieStr(): string {
  const raw = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
  return Array.isArray(raw)
    ? raw.map((c: any) => c.name + '=' + c.value).join('; ')
    : Object.entries(raw).map(([k, v]) => k + '=' + v).join('; ');
}

function csrfToken(cookieStr: string): string {
  return (cookieStr.match(/csrftoken=([^;]+)/) || [])[1] || '';
}

function baseHeaders(lessonId?: string): Record<string, string> {
  const cookieStr = getCookieStr();
  return {
    Cookie: cookieStr,
    'X-CSRFToken': csrfToken(cookieStr),
    Origin: BASE,
    Referer: BASE + (lessonId ? '/lesson/fullscreen/v3/' + lessonId : '/web'),
    'X-Client': 'h5',
    xtbz: 'ykt'
  };
}

// 每个课堂一个 30 秒 set-auth token；切换课堂时不会串用
const authByLesson = new Map<string, string>();

export function getAuth(lessonId = getSelectedLessonId()): string {
  return authByLesson.get(lessonId) || '';
}

export async function checkin(lessonId = getSelectedLessonId()): Promise<{ status: number; ok: boolean; setAuth: boolean; lessonToken: string; code: number; msg: string; ended: boolean }> {
  if (!lessonId) throw new Error('未选择课堂：请在 WebUI 选择正在上课的课堂，或设置 LESSON_ID');
  const r = await fetch(BASE + '/api/v3/lesson/checkin', {
    method: 'POST',
    headers: { ...baseHeaders(lessonId), 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 5, lessonId }),
    signal: AbortSignal.timeout(20000)
  });
  const setAuth = r.headers.get('set-auth') || '';
  if (setAuth) authByLesson.set(lessonId, setAuth);
  let j: any = null;
  try { j = await r.json(); } catch { /* ignore */ }
  const token: string = j?.data?.lessonToken || '';
  const code = Number(j?.code) || 0;
  const msg = String(j?.msg || '');
  const ended = code === 50004 || /LESSON_END|lesson.?end|已下课|课堂已结束/i.test(msg);
  return { status: r.status, ok: r.status === 200 && !!token, setAuth: !!setAuth, lessonToken: token, code, msg, ended };
}

export async function api(path: string, opts: { method?: string; body?: unknown; noAuth?: boolean; lessonId?: string } = {}): Promise<ApiResult> {
  const lessonId = opts.lessonId || getSelectedLessonId();
  const method = opts.method || 'GET';
  const doFetch = async (): Promise<Response> => {
    const headers = baseHeaders(lessonId);
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (!opts.noAuth) {
      const token = getAuth(lessonId);
      if (token) headers.Authorization = 'Bearer ' + token;
    }
    return fetch(BASE + path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(30000)
    });
  };
  let r = await doFetch();
  if (r.status === 401 && !opts.noAuth) {
    const t = await checkin(lessonId);
    if (t.setAuth) r = await doFetch();
  }
  const setAuth = r.headers.get('set-auth') || '';
  if (setAuth) authByLesson.set(lessonId, setAuth);
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, setAuth: !!setAuth, json, text: text.slice(0, 4000) };
}

export async function fetchLessons(): Promise<LessonInfo[]> {
  const r = await fetch(BASE + '/api/v3/classroom/on-lesson-upcoming-exam', {
    headers: { ...baseHeaders(), Accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(20000)
  });
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* ignore */ }
  if (r.status !== 200 || !j || j.code !== 0) {
    throw new Error('获取课堂列表失败: HTTP ' + r.status + ' ' + text.slice(0, 160));
  }
  return (j.data?.onLessonClassrooms || []) as LessonInfo[];
}

export async function fetchUserInfo(): Promise<{ name: string; userId: string; schoolNumber?: string }> {
  const r = await fetch(BASE + '/v2/api/web/userinfo', {
    headers: { ...baseHeaders(), Accept: 'application/json, text/plain, */*', 'x-client': 'web, h5' },
    signal: AbortSignal.timeout(20000)
  });
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* ignore */ }
  const d = Array.isArray(j?.data) ? j.data[0] : j?.data;
  if (r.status !== 200 || !d) throw new Error('获取用户信息失败: HTTP ' + r.status);
  return { name: String(d.name || ''), userId: String(d.user_id || d.UserID || ''), schoolNumber: String(d.school_number || '') };
}
