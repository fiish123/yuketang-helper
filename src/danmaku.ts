// 弹幕高峰检测：滑动窗口内弹幕密度超过阈值 → 认为进入一个“高峰”
// 高峰内只触发一次，取窗口内被重复最多的文本；连续安静 quietMs 或持续超过 maxPeakMs 后高峰结束。

export interface DanmuOptions {
  windowMs: number;
  threshold: number;
  minRepeat: number;
  quietMs: number;
  maxPeakMs: number;
  maxLen: number;
  selfId: string;
}

export interface DanmuTop {
  text: string;
  count: number;
  firstTs: number;
  lastTs: number;
}

export interface DanmuPushResult {
  action: 'trigger' | 'peak-wait' | 'in-peak' | 'collect';
  text?: string;
  rawText?: string;
  count?: number;
  window: number;
  list?: DanmuTop[];
  peakStart?: number;
  delayed?: boolean;
}

interface Frame { ts: number; text: string; userid: string; }
interface Peak { startTs: number; lastTs: number; handled: boolean; text: string; count: number; }

export const DANMU_DEFAULTS: DanmuOptions = {
  windowMs: 60000,
  threshold: 8,
  minRepeat: 3,
  quietMs: 30000,
  maxPeakMs: 120000,
  maxLen: 50,
  selfId: ''
};

const cleanText = (s: unknown): string => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

export class DanmuDetector {
  opts: DanmuOptions;
  now: () => number;
  frames: Frame[];
  peak: Peak | null;
  lastFrameTs: number;
  total: number;
  triggered: number;
  lastTop: DanmuTop | null;
  lastAction: string | null;

  constructor(opts: Partial<DanmuOptions> = {}, now: () => number = () => Date.now()) {
    this.opts = { ...DANMU_DEFAULTS, ...opts };
    this.now = now;
    this.frames = [];
    this.peak = null;
    this.lastFrameTs = 0;
    this.total = 0;
    this.triggered = 0;
    this.lastTop = null;
    this.lastAction = null;
  }

  setSelfId(id: string | number): void { this.opts.selfId = String(id || ''); }

  prune(now: number): void {
    const cutoff = now - this.opts.windowMs;
    while (this.frames.length && this.frames[0].ts < cutoff) this.frames.shift();
  }

  top(now: number = this.now()): DanmuTop[] {
    this.prune(now);
    const map = new Map<string, DanmuTop>();
    for (const f of this.frames) {
      if (this.opts.selfId && f.userid === this.opts.selfId) continue;
      const item = map.get(f.text);
      if (item) { item.count++; item.lastTs = f.ts; }
      else map.set(f.text, { text: f.text, count: 1, firstTs: f.ts, lastTs: f.ts });
    }
    const list = [...map.values()].sort((a, b) => b.count - a.count || a.firstTs - b.firstTs);
    this.lastTop = list[0] || null;
    return list;
  }

  endPeak(reason: string): (Peak & { endReason: string; endTs: number }) | null {
    const p = this.peak;
    this.peak = null;
    this.frames = [];   // 高峰结束后清空窗口，避免旧弹幕把下一个高峰直接顶起来
    return p ? { ...p, endReason: reason, endTs: this.now() } : null;
  }

  push(rawText: unknown, userid: string | number = ''): DanmuPushResult | null {
    const now = this.now();
    const text = cleanText(rawText);
    if (!text) return null;
    const uid = String(userid || '');

    if (this.peak && now - this.lastFrameTs >= this.opts.quietMs) this.endPeak('quiet');
    if (this.peak && now - this.peak.startTs >= this.opts.maxPeakMs) this.endPeak('max');

    this.lastFrameTs = now;
    this.frames.push({ ts: now, text, userid: uid });
    this.total++;
    this.prune(now);

    let result: DanmuPushResult;
    if (!this.peak && this.frames.length >= this.opts.threshold) {
      const list = this.top(now);
      const top = list[0];
      this.peak = { startTs: now, lastTs: now, handled: false, text: top ? top.text : '', count: top ? top.count : 0 };
      if (top && top.count >= this.opts.minRepeat) {
        this.peak.handled = true;
        this.triggered++;
        result = { action: 'trigger', text: top.text.slice(0, this.opts.maxLen), rawText: top.text, count: top.count, window: this.frames.length, list: list.slice(0, 5), peakStart: now };
      } else {
        result = { action: 'peak-wait', text: top ? top.text : '', count: top ? top.count : 0, window: this.frames.length, list: list.slice(0, 5), peakStart: now };
      }
    } else if (this.peak) {
      this.peak.lastTs = now;
      if (!this.peak.handled) {
        const list = this.top(now);
        const top = list[0];
        if (top && top.count >= this.opts.minRepeat) {
          this.peak.handled = true; this.peak.text = top.text; this.peak.count = top.count; this.triggered++;
          result = { action: 'trigger', text: top.text.slice(0, this.opts.maxLen), rawText: top.text, count: top.count, window: this.frames.length, list: list.slice(0, 5), peakStart: this.peak.startTs, delayed: true };
        } else {
          this.peak.text = top ? top.text : ''; this.peak.count = top ? top.count : 0;
          result = { action: 'in-peak', window: this.frames.length };
        }
      } else {
        result = { action: 'in-peak', window: this.frames.length };
      }
    } else {
      result = { action: 'collect', window: this.frames.length };
    }
    this.lastAction = result.action;
    return result;
  }

  snapshot(): any {
    const now = this.now();
    this.prune(now);
    const peakActive = !!this.peak && (now - this.lastFrameTs < this.opts.quietMs) && (now - this.peak.startTs < this.opts.maxPeakMs);
    return {
      ts: now,
      peak: peakActive ? { ...this.peak!, durationMs: now - this.peak!.startTs } : null,
      stalePeak: this.peak && !peakActive ? { ...this.peak, note: '已安静，等待下一条弹幕收尾' } : null,
      windowCount: this.frames.length,
      windowMs: this.opts.windowMs,
      threshold: this.opts.threshold,
      minRepeat: this.opts.minRepeat,
      quietMs: this.opts.quietMs,
      maxPeakMs: this.opts.maxPeakMs,
      maxLen: this.opts.maxLen,
      total: this.total,
      triggered: this.triggered,
      lastTop: this.lastTop,
      lastAction: this.lastAction
    };
  }
}
