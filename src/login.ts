// 命令行扫码登录：生成二维码后等待扫码，成功后写入 cookies.json
import { STATE } from './config.ts';
import { startLogin, loginStatus } from './monitor.ts';

const force = process.argv.includes('--force');
const s = await startLogin(force);
if (!s || s.status !== 'waiting') {
  console.log('[login] 启动失败:', JSON.stringify(s));
  process.exit(1);
}
console.log('[login] 二维码已生成:', STATE + '/login_qr.png');
console.log('[login] 请用微信或雨课堂 APP 扫码；等待 5 分钟…');
const started = Date.now();
let last = '';
while (Date.now() - started < 300000) {
  const cur = loginStatus();
  if (cur && cur.status === 'ok') {
    console.log('[login] 登录成功:', JSON.stringify(cur.user));
    process.exit(0);
  }
  if (cur && (cur.status === 'error' || cur.status === 'timeout')) {
    console.log('[login] 登录失败:', JSON.stringify(cur));
    process.exit(1);
  }
  const msg = cur ? String(cur.status) + (cur.error ? ' ' + cur.error : '') : 'unknown';
  if (msg !== last) { console.log('[login]', msg); last = msg; }
  await new Promise(r => setTimeout(r, 1500));
}
console.log('[login] 超时');
process.exit(1);
