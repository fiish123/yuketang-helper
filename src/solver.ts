import fs from 'node:fs';
import path from 'node:path';
import { getSettings, getSelectedLesson } from './config.ts';

const API = 'https://api.deepseek.com/chat/completions';

export interface SolveResult {
  ok: boolean;
  answers: string[] | null;
  reason: string;
  raw: string;
  ms: number;
  usage?: unknown;
}

export function getModel(): string {
  return getSettings().model || process.env.DS_MODEL || 'deepseek-flash';
}

export function getApiKey(): string {
  return String(getSettings().apiKey || process.env.DEEPSEEK_API_KEY || '').trim();
}

export function hasApiKey(): boolean {
  return !!getApiKey();
}

function loadKey(): string {
  const key = getApiKey();
  if (!key) throw new Error('未配置 DeepSeek API Key：请在 WebUI 右上角「设置」中填写，或设置 DEEPSEEK_API_KEY');
  return key;
}

function systemPrompt(): string {
  const course = String(getSelectedLesson().lessonName || '').trim();
  const hint = course ? '本课程是「' + course + '」。' : '';
  return hint + '看题图作答，只输出一个JSON对象，不要解释或markdown：{"answers":["A"]}。多选题输出全部正确选项。';
}

export function extractJSON(txt: string | null | undefined): any {
  if (!txt) return null;
  const s = String(txt).trim();
  try { const o = JSON.parse(s); if (o && typeof o === 'object') return o; } catch { /* ignore */ }
  const f = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (f) { try { const o = JSON.parse(f[1].trim()); if (o && typeof o === 'object') return o; } catch { /* ignore */ } }
  const start = s.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { try { const o = JSON.parse(s.slice(start, i + 1)); if (o && typeof o === 'object') return o; } catch { /* ignore */ } break; } }
    }
  }
  const m = s.match(/"answers"\s*:\s*\[([^\]]*)\]/);
  if (m) { const arr = [...m[1].matchAll(/[A-H]/gi)].map(x => x[0].toUpperCase()); if (arr.length) return { answers: arr, reason: '' }; }
  return null;
}

export function normalize(out: any): { answers: string[]; reason: string } | null {
  if (!out || !Array.isArray(out.answers)) return null;
  const answers: string[] = [...new Set<string>(out.answers.map((x: unknown) => String(x).trim().toUpperCase()).filter((x): x is string => /^[A-H]$/.test(x)))].sort();
  if (!answers.length) return null;
  return { answers, reason: String(out.reason || '').slice(0, 300) };
}

export async function solve(imagePath: string, opts: { effort?: string; temperature?: number; timeoutMs?: number; model?: string; signal?: AbortSignal } = {}): Promise<SolveResult> {
  const key = loadKey();
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const ext = (path.extname(imagePath).replace('.', '') || 'webp').toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  const body = {
    model: opts.model || getModel(),
    thinking: { type: 'enabled' },
    reasoning_effort: opts.effort || 'high',
    temperature: opts.temperature ?? 0,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/${mime};base64,${b64}` } },
        { type: 'text', text: '输出答案JSON（只含 answers）' }
      ] }
    ]
  };
  const t0 = Date.now();
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 120000);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
  } catch (e: any) {
    if (opts.signal?.aborted) throw e;
    if (timeout.aborted) throw new Error('解题超时（超过 ' + Math.round(timeoutMs / 1000) + ' 秒）');
    throw e;
  }
  let j: any;
  try {
    j = await res.json();
  } catch (e: any) {
    if (opts.signal?.aborted) throw e;
    if (timeout.aborted) throw new Error('解题超时（超过 ' + Math.round(timeoutMs / 1000) + ' 秒）');
    throw e;
  }
  const ms = Date.now() - t0;
  if (!res.ok || j.error) throw new Error('api ' + res.status + ' ' + JSON.stringify(j.error || j).slice(0, 200));
  const msg = j.choices?.[0]?.message || {};
  const out = normalize(extractJSON(msg.content));
  return { ok: !!out, answers: out ? out.answers : null, reason: out ? out.reason : '', raw: msg.content || '', ms, usage: j.usage };
}
