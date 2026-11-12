# 长江雨课堂 · 课堂助手

自动发现正在进行课堂的新题，抓取题面图片，调用 DeepSeek 视觉解题并提交；同时提供弹幕高峰跟发、随机点名监控和本地 WebUI。

## 功能

- 实时监听课堂 WebSocket，发现新题后自动取题图、解题、提交（可关闭自动提交）
- 本地 WebUI：题目卡片、题面图、手动勾选提交、AI 解题/强制重试、事件/提交/解题记录
- WebUI 设置：DeepSeek API Key、进行中课堂选择、桌面通知；未选课堂/未配 Key 时自动打开设置
- 课堂切换时弹窗选择是否清空当前课堂历史；设置里也可手动清空
- AI 解题包含重试的总时长上限 120 秒，超时自动停止
- 课堂结束自动停机：checkin 返回 `LESSON_END` 后停止课堂轮询、WS 重连和自动提交，等待选择新课堂
- 弹幕高峰检测：窗口内弹幕暴增时，跟发一条被重复最多的弹幕（每个高峰只发一次）
- 点名监控：识别随机点名事件，点中自己时弹出红色提醒 + 声音/桌面通知；只提醒，不自动应答、不签到

## 平台支持

- Windows 10/11、Linux、macOS 均可运行；核心逻辑只依赖 Node.js 标准 API，不依赖 Chromium/CDP。
- Node.js 必须 >= 24（直接运行 `.ts`，使用 Node 原生 type stripping，不需要 tsx）。
- 包管理器使用 pnpm。
- 登录二维码由程序通过 HTTP 获取并写到 `state/login_qr.png`，不需要打开可抓包浏览器。
- Windows 上 `SIGUSR1` 不可用：修改 `state/answers.json` 后重启 watcher 即可重新加载；`chmod 0600` 只是尽力而为。
- Windows 终端如果中文显示乱码，先执行 `chcp 65001` 再运行命令。

## 安装

先确认 Node 24 和 pnpm 12：

```bash
node -v
pnpm -v
```

如果 Windows 上还没有 pnpm：

```powershell
corepack enable
corepack prepare pnpm@12.14.0 --activate
# 或者：npm install -g pnpm@12.14.0
```

安装依赖：

```bash
pnpm install
```

可选：复制环境变量模板。也可以完全不建 `.env`，启动后在 WebUI 里配置。

PowerShell：

```powershell
Copy-Item .env.example .env
```

Linux/macOS：

```bash
cp .env.example .env
```

## 一键启动

`pnpm start` 会在一个入口里同时启动 WebUI 和课堂 watcher，并自动打开浏览器：

```bash
pnpm start
```

Windows 也可以直接双击项目根目录的 `start.bat`；Linux/macOS 可运行 `./start.sh`。不需要自动打开浏览器时：

```bash
OPEN=0 pnpm start          # Linux/macOS
$env:OPEN=0; pnpm start    # Windows PowerShell
```

停止：前台运行时按 `Ctrl+C`，会同时结束 WebUI 和 watcher。

## 首次手动流程（干净状态）

1. 启动一键入口：

   ```bash
   pnpm start
   ```

2. 浏览器会打开 <http://127.0.0.1:8799/>（没打开就手动访问）。未登录时页面自动弹出二维码；用微信或雨课堂 APP 扫码。
   - 扫码成功后 cookie 写入 `state/cookies.json`。
   - 也可以先运行 `pnpm login`，二维码在 `state/login_qr.png`。

3. 点右上角「设置」：
   - 填 DeepSeek API Key，保存到 `state/settings.json`（权限 0600；也可用环境变量 `DEEPSEEK_API_KEY`）。
   - 点「刷新列表」，选择正在上课的课堂，再点「切换到该课堂」。
   - 如果还没有选择课堂或还没有配置 Key，页面会自动打开一次设置并提示原因。

4. watcher 已经在后台运行，会每 3 秒检查一次 WebUI 选择的课堂；选中后自动连接，不需要再开终端。切换课堂会自动断开旧 WS、重连新课堂，并把时间线基线重置到当前时刻，避免把历史题当新题。如果当前课堂已有历史数据，会先弹窗选择「清空并切换 / 保留并切换 / 取消」；清空不可恢复，但登录状态与 API Key 会保留。设置里也有「清空本课堂历史」。

5. 课堂结束后，checkin 会返回 `LESSON_END`。watcher 会停止课堂请求、WS 重连和自动提交，WebUI 显示「课堂已结束」并停止快速轮询；选择新的进行中课堂后恢复。

6. 新题出现后，卡片会自动增加。未配置 Key 或解题失败会停在「待处理」，可点「AI 解题」重新解题（解题中再次点击会强制中断并重开），勾选后「手动提交答案」。

### 重置本地配置

```bash
# Linux/macOS
rm -rf state
# Windows PowerShell
Remove-Item -Recurse -Force state
```

删除 `state/` 会同时清除登录 cookie、设置、题目/答题记录、日志和二维码。若要连环境变量一起重置，再删除 `.env`。

### 清空当前课堂历史

切换课堂时如果当前课堂已有题目记录，WebUI 会弹窗询问；也可以随时在「设置 → 历史数据」里手动清空，或调用：

```bash
curl -s -X POST http://127.0.0.1:8799/history/clear \
  -H 'Content-Type: application/json' -d '{"mode":"manual"}'
```

清空会删除题目、答案、提交/解题记录、封面、弹幕和点名记录，不归档；保留登录 cookie、API Key、课堂选择和登录二维码。`mode` 为 `manual` 时保留当前 presentation 缓存，`switch` 时一并清除，供切换课堂后重新发现。

## 进程说明

- 日常使用：`pnpm start`（一键启动 WebUI + watcher）。
- 调试单个进程：

```bash
# 只启动 WebUI / API
pnpm server

# 只启动课堂 WebSocket 监听 + 解题 + 弹幕 + 点名
pnpm watcher
```

WebUI 只监听 `127.0.0.1`，默认端口 `8799`。

## 鉴权链路

1. 登录 Cookie：`sessionid`、`csrftoken`（以及 `login_type=WX` 等）。
2. `POST /api/v3/lesson/checkin` body `{source:5, lessonId}`
   - 响应体 `data.lessonToken`：JWT，约 5 小时，用于 WebSocket `hello.auth`
   - 响应头 `set-auth`：JWT，约 30 秒，用作 `Authorization: Bearer <set-auth>`
3. 课堂 API 统一带：`Authorization: Bearer <set-auth>`、`X-Client: h5`、`xtbz: ykt`、`Referer: /lesson/fullscreen/v3/<lessonId>`。
4. 任意带鉴权响应都会回新的 `set-auth`，客户端自动轮换；401 时重新 checkin 重试一次。
5. `presentation_id` 从 WS 帧（`slidenav.slide.pres` / `unlockproblem.problem.pres` / timeline 的 `pres`）获得，写入 `state/presentation.json`，不再硬编码。

## 实时题目发现

WS：`wss://changjiang.yuketang.cn/wsapp/`

```json
{"op":"hello","userid":"<identityId>","role":"student","auth":"<lessonToken>","lessonid":"<lessonId>"}
{"op":"fetchtimeline","lessonid":"<lessonId>","msgid":1}
```

常见推题帧：

- `{"op":"slidenav",...,"unlockedproblem":["<problemId>"],"slide":{"si":39,...}}`
- `{"op":"unlockproblem","problem":{"prob":"<problemId>","si":39,"dt":...,"limit":-1},...}`
- `{"op":"probleminfo","problemid":"<problemId>","dt":...}`

收到新 problemId 后，从 presentation 找对应 slide 的 `coverAlt` 图片，存到 `state/covers/<problemId>.webp`。

历史题判定：优先读 presentation 的 `problem.result`（已有结果=已答，直接记为 `submitted`）和 `problem.sendTime`（早于本次时间线基线=历史题，记为 `historical` 并跳过），页码统一用 `slide.index`。这样老师翻回旧题时，不会把第 29 页显示成当前第 80 页，也不会重新解题/提交。

## 题面为什么必须看图

presentation 接口里 `problem.body` 恒为空、`options[].value` 恒为空；`problem/choice-detail`、`problem/blank-detail`、`problem/fetch-answer` 学生 token 一律 403。题干和选项只存在于 slide 封面图里，页面 DOM 也没有文本。因此取题只能下载图片，解题调用视觉模型；没有可直接拿题面文本的接口。

题型（本课程实测）：`1` 单选、`2` 多选、`3` 投票（无对错，参与即可）、`4` 填空、`5` 主观。自动提交目前主要覆盖 1/2/3 的字母选项；填空/主观题会停在待处理（可按需扩展）。

## 本地 API

| 路由 | 说明 |
|---|---|
| `GET /` | WebUI |
| `GET /health` | 当前课堂、presentationId、已发现题数 |
| `GET /problems` | 所有题目（problemId/si/type/status/result） |
| `GET /pending` | 未提交题目 |
| `GET /problem?id=<pid>` | 单题状态 |
| `GET /cover/<pid>` | 题面图（缺失时自动下载） |
| `POST /answer` | `{"problemId":"...","result":["C","D"]}` 提交 |
| `POST /solve` | `{"problemId":"..."}` 只解题不提交；同题再次调用会强制中断旧解题并重新开始 |
| `POST /auto` | 解题 + 等待最小间隔 + 提交 |
| `GET /status` | 登录/watcher/统计/设置/提交/解题 |
| `GET /logs?n=50` | watcher.log 尾部 |
| `GET /settings` | API Key 是否配置、模型、当前课堂 |
| `POST /settings/api-key` | `{"apiKey":"sk-..."}`；空串=清除，长度<10 拒绝 |
| `GET /lessons` | 进行中课堂列表 |
| `POST /lesson/select` | `{"lessonId":"..."}`，必须在进行中列表 |
| `POST /history/clear` | `{"mode":"manual"\|"switch"}` 清空当前课堂历史；有历史时切换课堂由前端先调用 |
| `GET /login/status`、`GET /login/start`、`GET /qr.png` | 扫码登录 |
| `GET /danmu?n=30`、`GET /danmu/status`、`POST /danmu/send` | 弹幕 |
| `GET /rollcall?n=30`、`GET /rollcall/status`、`POST /rollcall/ack` | 点名 |

提交示例：

```bash
curl -s -X POST http://127.0.0.1:8799/answer -H 'Content-Type: application/json' \
  -d '{"problemId":"<problemId>","result":["A","B"]}'
```

## 自动解题与防秒答

- 解题：DeepSeek `deepseek-flash` 视觉输入，thinking enabled、reasoning_effort high、temperature 0。提示词会带上当前课堂/课程名称，只要求输出 `{"answers":[...]}`，不需要 `reason` 字段。
- 单次请求超时 120 秒；`SOLVE_DEADLINE_MS=120000` 限制同一道题包含重试的总时长，超时会停止重试并把题目标为失败。
- 自动解题与手动解题共用 `src/solveRun.ts` 的同一套流程；同一道题开始新解题时，旧解题会被强制中止，最新请求胜出。被中止的自动解题不会继续提交旧答案。
- Key 优先级：WebUI `state/settings.json` → `DEEPSEEK_API_KEY`。
- 题图缓存：`state/covers/`；答案缓存：`state/answers.json`（按 problemId）。
- 解题重试 `SOLVE_RETRIES=2`（共 3 次）；提交重试 `SUBMIT_RETRIES=2`，403/50013 立即停止。
- 最小间隔：题目推送后至少 `MIN_DELAY_MS=40000` 毫秒再提交；手动 `/answer` 不受限；`/auto` 可传 `minDelayMs` 覆盖。
- `AUTO=0` 只记录不提交；`AUTO_SOLVE=0` 不自动解题（只使用预置答案）。
- 修改 `answers.json` 后，Linux/macOS 可 `kill -USR1 <watcher pid>` 热加载；Windows 重启 watcher。

## 弹幕高峰自动跟发

监听 `newdanmu` / `systemdanmu`，滑动窗口统计；窗口内达到阈值进入高峰，取重复最多的文本跟发一次；同一高峰只发一次，安静 30 秒或持续 2 分钟后结束。

- 默认 `DANMU_WINDOW_MS=60000`（60 秒）、`DANMU_THRESHOLD=8`、`DANMU_MIN_REPEAT=3`。
- 高峰结束会清空窗口，避免旧弹幕把下一个高峰直接顶起来。
- 自己的 userId 不参与统计。
- `DANMU_SEND=0` 只观察不发送；`DANMU=0` 完全关闭。
- 发送接口：`POST /api/v3/lesson/danmu/send`，body 与网页一致（`fromStart:"50"`，文本≤50 字）。

记录：`state/danmu.jsonl`、`state/danmu_status.json`。

## 点名监控（只提醒）

学生端没有可直接调用的点名 API；点名由教师端触发，预期通过课堂事件 `code=RANDOM_PICK`（JS 里的 `radomrollcall`）或 WS 帧下发。当前实现是启发式：

- 递归识别 `code==='RANDOM_PICK'`、`op` 匹配 `rollcall|roll_call|random.?pick|random.?call|dianming`、或 `type==='event'` 且 title 含「点名」。
- 收集帧内字符串，包含自己的姓名（≥2 字）或 userId/identityId 即判定 `hit`。
- 命中时：写 `state/rollcall.jsonl` 与 `state/rollcall_status.json`，WebUI 红色横幅 + 双音提示 + 可选桌面通知；终端响铃。
- 只提醒，不自动签到、不自动应答、不提交任何内容。
- 点「知道了」写入 `state/rollcall_ack.json`，刷新页面不会重复弹旧提醒。
- `ROLLCALL=0` 关闭。

注意：抓包期间没有真实点名，帧格式尚未实测；如果老师端实际字段不同，需要根据真实帧补充识别规则（先看 `state/rollcall.jsonl` 是否有记录）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LESSON_ID` | 空 | 课堂 id；空则用 WebUI 选择 |
| `PORT` | `8799` | 本地端口 |
| `OPEN` | `1` | 一键启动是否自动打开浏览器；`0` 关闭 |
| `STATE_DIR` | `./state` | 状态目录 |
| `COOKIE_FILE` | `./state/cookies.json` | 登录 cookie |
| `DEEPSEEK_API_KEY` | 空 | 视觉解题 Key |
| `DS_MODEL` | `deepseek-flash` | 模型 |
| `AUTO` | `1` | 0=只记录不提交 |
| `AUTO_SOLVE` | `1` | 0=不自动解题 |
| `MIN_DELAY_MS` | `40000` | 推送后最小提交间隔 |
| `SOLVE_RETRIES` | `2` | 解题额外重试次数 |
| `SOLVE_DEADLINE_MS` | `120000` | 单题解题含重试总时长上限 |
| `SUBMIT_RETRIES` | `2` | 提交额外重试次数 |
| `DANMU` | `1` | 弹幕监控开关 |
| `DANMU_SEND` | `1` | 0=只观察不发送 |
| `DANMU_WINDOW_MS` | `60000` | 弹幕统计窗口 |
| `DANMU_THRESHOLD` | `8` | 窗口内多少条算高峰 |
| `DANMU_MIN_REPEAT` | `3` | 最低重复次数 |
| `DANMU_QUIET_MS` | `30000` | 安静结束时间 |
| `DANMU_MAX_PEAK_MS` | `120000` | 高峰最长持续时间 |
| `DANMU_MAX_LEN` | `50` | 发送文本上限 |
| `ROLLCALL` | `1` | 点名监控开关 |

## 目录

```
src/
  config.ts       路径、.env、settings.json
  lessonClient.ts checkin/30s Bearer/API 封装
  monitor.ts      登录、二维码、状态聚合
  solver.ts       DeepSeek 视觉解题（课程名提示）
  solveRun.ts     解题协调：跨进程强制中断/重开、总超时
  history.ts      历史清空请求/完成标记与文件清理
  danmaku.ts      弹幕高峰检测
  rollcall.ts     点名识别
  watcher.ts      WS 监听、动态课堂、自动提交
  server.ts       本地 API
  dashboard.html  WebUI
  login.ts        命令行扫码登录
scripts/
  launch.mjs      一键启动 WebUI + watcher（自动开浏览器，Ctrl+C 全停）
start.bat         Windows 双击启动
start.sh          Linux/macOS 启动脚本
tests/
  danmaku.test.ts
  rollcall.test.ts
  solveRun.test.ts
  history.test.ts
  fixtures/danmu_frames.json  已匿名的真实弹幕回放样本
state/            运行状态（首次启动自动创建，含 cookie/settings/日志）
```

## 测试

```bash
pnpm typecheck
pnpm test
```

测试脚本使用显式文件名，兼容 Windows 的 cmd/PowerShell（不依赖 shell 通配符展开）。

## 注意

- 30 秒 Bearer 过期很快，提交前必须 checkin（客户端已处理）。
- 提交接口在答题结束后返回 403；只能在新题推送后、老师结束答题前提交。
- 自动提交依赖模型答案正确性；没有 Key 或模型失败会停在 pending，可人工在 WebUI 提交。
- 课堂 API 有风控风险，避免高频轮询；watcher 只依赖 WS 推送和一次 timeline 拉取。
- 本项目仅用于个人学习辅助，请遵守课堂与学校规定。
