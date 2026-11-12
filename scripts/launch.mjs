// 一键启动：WebUI + 课堂 watcher；Ctrl+C 同时停止。
// 跨平台：Windows / Linux / macOS 均使用 Node 子进程，不依赖 bash。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.YUKETANG_ROOT
  ? path.resolve(process.env.YUKETANG_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 与 src/config.ts 保持一致：让 .env 里的 PORT 也作用于启动器和健康检查
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env 不存在时忽略 */ }
const PORT = Number(process.env.PORT || 8799);
const BASE = 'http://127.0.0.1:' + PORT + '/';
const children = new Map();
let shuttingDown = false;

function log(msg) { console.log('[launch] ' + msg); }
function err(msg) { console.error('[launch] ' + msg); }

function forward(name, stream) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    for (const line of lines) process.stdout.write('[' + name + '] ' + line + '\n');
  });
  stream.on('end', () => { if (buf) process.stdout.write('[' + name + '] ' + buf + '\n'); });
}

function launchChild(name, script) {
  const child = spawn(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  children.set(name, child);
  if (child.stdout) forward(name, child.stdout);
  if (child.stderr) forward(name, child.stderr);
  child.on('error', (e) => {
    err(name + ' 启动失败：' + (e && e.message ? e.message : e));
    if (name === 'server') shutdown(1);
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const detail = code == null ? ('signal ' + signal) : ('code ' + code);
    err(name + ' 已退出（' + detail + '）');
    if (name === 'server') shutdown(code == null ? 1 : code);
    else err('WebUI 仍在运行；修复 watcher 后重新执行 pnpm start');
  });
  return child;
}

async function serverUp() {
  try {
    const r = await fetch(BASE + 'health', { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch { return false; }
}

async function waitHealth(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await serverUp()) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

function openBrowser(url) {
  if (process.env.OPEN === '0') { log('OPEN=0，已禁用自动打开浏览器'); return; }
  const cmd = process.platform === 'win32' ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => err('无法自动打开浏览器，请手动打开 ' + url));
    p.unref();
  } catch {
    err('无法自动打开浏览器，请手动打开 ' + url);
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('正在停止全部进程…');
  for (const child of children.values()) {
    try { if (child.exitCode == null) child.kill('SIGTERM'); } catch { /* ignore */ }
  }
  const deadline = Date.now() + 2500;
  const timer = setInterval(() => {
    const alive = [...children.values()].filter(c => c.exitCode == null);
    if (alive.length === 0 || Date.now() > deadline) {
      clearInterval(timer);
      for (const c of alive) { try { c.kill('SIGKILL'); } catch { /* ignore */ } }
      process.exit(code);
    }
  }, 100);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// 启动前检查，避免重复启动
if (!Number.isFinite(PORT) || PORT <= 0) { err('PORT 无效'); process.exit(1); }
if (!fs.existsSync(path.join(ROOT, 'node_modules', 'qrcode'))) {
  err('依赖未安装：先运行 pnpm install');
  process.exit(1);
}
if (await serverUp()) {
  err('端口 ' + PORT + ' 已有 WebUI 在运行：' + BASE);
  err('请先停止旧进程，或直接打开上面的地址。');
  process.exit(1);
}

log('启动 WebUI: ' + BASE);
const server = launchChild('server', 'src/server.ts');
if (!(await waitHealth(15000)) || shuttingDown) {
  if (!shuttingDown) {
    err('WebUI 15 秒内没有就绪，退出。');
    try { server.kill('SIGTERM'); } catch { /* ignore */ }
    shutdown(1);
  }
  // shutdown 的定时器会负责退出；这里不能再继续启动 watcher
  await new Promise(() => {});
}

log('启动课堂 watcher');
launchChild('watcher', 'src/watcher.ts');
log('已启动：扫码登录 → 设置 API Key → 选择课堂');
log('按 Ctrl+C 停止全部');
openBrowser(BASE);
