// 点名监控：只识别“随机点名”事件并判断是否点中自己；不做任何自动应答/签到。
// 雨课堂的学生端 WebSocket 事件里，点名事件的 code 为 RANDOM_PICK（JS 里写作 radomrollcall）。
// 兼容几种可能形态：event 时间线条目、独立 WS 帧、嵌套 data/event。

export interface SelfInfo {
  name: string;
  userId: string;
  identityId: string;
}

export interface RollcallEvent {
  ts: number;
  hit: boolean;
  selfName: string;
  title: string;
  text: string;
  picked: string;
  code: string;
  source: string;
  raw?: unknown;
}

const ROLLCALL_RE = /rollcall|roll_call|random.?pick|random.?call|dianming/i;
const ROLLCALL_TEXT_RE = /点名|随机点|roll\s*call/i;

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object';
}

export function isRollcallLike(v: unknown, depth = 0): boolean {
  if (!isObj(v) || depth > 4) return false;
  if (v.code === 'RANDOM_PICK') return true;
  if (typeof v.op === 'string' && ROLLCALL_RE.test(v.op)) return true;
  if (v.type === 'event' && (v.code === 'RANDOM_PICK' || ROLLCALL_TEXT_RE.test(String(v.title || '')))) return true;
  if (isObj(v.event) && isRollcallLike(v.event, depth + 1)) return true;
  if (isObj(v.data) && isRollcallLike(v.data, depth + 1)) return true;
  return false;
}

export function collectStrings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 5 || out.length > 400) return out;
  if (v == null) return out;
  if (typeof v === 'string') { if (v) out.push(v); return out; }
  if (typeof v === 'number' || typeof v === 'boolean') { out.push(String(v)); return out; }
  if (Array.isArray(v)) { for (const x of v) collectStrings(x, out, depth + 1); return out; }
  if (isObj(v)) { for (const x of Object.values(v)) collectStrings(x, out, depth + 1); }
  return out;
}

function pickedName(v: Record<string, any>, strings: string[]): string {
  if (Array.isArray(v.replace)) {
    const s = v.replace.filter((x: unknown) => x != null && String(x).trim()).join(' ').trim();
    if (s) return s.slice(0, 100);
  }
  for (const key of ['name', 'names', 'student', 'students', 'userName', 'username']) {
    if (v[key] != null) {
      const s = Array.isArray(v[key]) ? v[key].join(' ') : String(v[key]);
      if (s.trim()) return s.trim().slice(0, 100);
    }
  }
  const title = String(v.title || '').trim();
  const m = title.match(/[:：]\s*(.+)$/);
  if (m) return m[1].trim().slice(0, 100);
  const text = strings.join(' ').trim();
  return text.slice(0, 100);
}

export class RollcallDetector {
  self: SelfInfo;
  seen: Set<string>;
  total: number;
  hits: number;
  misses: number;
  last: RollcallEvent | null;

  constructor(self: SelfInfo = { name: '', userId: '', identityId: '' }) {
    this.self = self;
    this.seen = new Set();
    this.total = 0;
    this.hits = 0;
    this.misses = 0;
    this.last = null;
  }

  setSelf(self: Partial<SelfInfo>): void {
    this.self = { ...this.self, ...self, name: String(self.name ?? this.self.name ?? '').trim() };
  }

  inspect(v: unknown, source = 'ws'): RollcallEvent | null {
    if (!isRollcallLike(v)) return null;
    const obj: Record<string, any> = isObj(v) ? (isObj(v.event) && isRollcallLike(v.event) ? v.event : v) : {};
    const strings = collectStrings(v);
    const joined = strings.join(' ').slice(0, 2000);
    const name = this.self.name.trim();
    const ids = [this.self.userId, this.self.identityId].filter(Boolean);
    const idHit = ids.some(id => strings.some(s => s === id) || new RegExp('(^|[^0-9])' + id + '([^0-9]|$)').test(joined));
    const nameHit = name.length >= 2 && joined.includes(name);
    const hit = nameHit || idHit;
    const title = String(obj.title || obj.msg || obj.message || obj.text || '').trim();
    const picked = pickedName(obj, strings);
    const code = String(obj.code || obj.op || (obj.type === 'event' ? 'EVENT' : 'UNKNOWN'));
    const key = [code, title, obj.dt || obj.ts || '', picked].join('|');
    if (this.seen.has(key)) return null;
    this.seen.add(key);
    if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value as string);
    this.total++;
    if (hit) this.hits++; else this.misses++;
    const event: RollcallEvent = {
      ts: Date.now(),
      hit,
      selfName: name,
      title: title || (hit ? '随机点名选中了你' : '随机点名'),
      text: joined.slice(0, 600),
      picked,
      code,
      source,
      raw: v
    };
    this.last = event;
    return event;
  }
}
