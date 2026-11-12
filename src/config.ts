import fs from 'node:fs';
import path from 'node:path';

// 项目根目录：src/ 的上一级；也可用 YUKETANG_ROOT 覆盖
export const ROOT = process.env.YUKETANG_ROOT
  ? path.resolve(process.env.YUKETANG_ROOT)
  : path.resolve(import.meta.dirname, '..');

// .env 可选加载（Node 20.12+ 自带），不引入 dotenv
try {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
} catch { /* ignore */ }

export const STATE = process.env.STATE_DIR ? path.resolve(process.env.STATE_DIR) : path.join(ROOT, 'state');
export const COOKIE_FILE = process.env.COOKIE_FILE ? path.resolve(process.env.COOKIE_FILE) : path.join(STATE, 'cookies.json');
export const DASHBOARD_HTML = path.join(import.meta.dirname, 'dashboard.html');
export const PORT = Number(process.env.PORT || 8799);
export const BASE = 'https://changjiang.yuketang.cn';

fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });

export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

export function writeJson(file: string, value: unknown, mode?: number): void {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  if (mode != null) {
    try { fs.chmodSync(tmp, mode); } catch { /* Windows/POSIX 不支持的挂载点会忽略权限位 */ }
  }
  fs.renameSync(tmp, file);
}

export interface Settings {
  apiKey?: string;
  model?: string;
  lessonId?: string;
  lessonName?: string;
  classroomId?: string;
  classroomName?: string;
  selectedAt?: number;
}

const SETTINGS_FILE = path.join(STATE, 'settings.json');

export function getSettings(): Settings {
  return readJson<Settings>(SETTINGS_FILE, {});
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  writeJson(SETTINGS_FILE, next, 0o600);
  return next;
}

export function getSelectedLessonId(): string {
  const s = getSettings();
  return String(s.lessonId || process.env.LESSON_ID || '').trim();
}

export function getSelectedLesson(): { lessonId: string; lessonName: string } {
  const s = getSettings();
  return { lessonId: String(s.lessonId || process.env.LESSON_ID || '').trim(), lessonName: String(s.lessonName || '') };
}

export function maskKey(key: string | undefined): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return key.slice(0, 3) + '****' + key.slice(-4);
}

export function numEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
