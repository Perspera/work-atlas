# B 组验收报告（本地 · 不动线上）

- 日期：2026-11-11
- 范围：`P4-剩余事项清单.md` B-1 ~ B-7 + 架构计划 §7「前端验收清单（P4 专用）」11 项
- 分工裁定（m00002）：我代跑可自动化部分，浏览器相关由用户人工走查
- 结论：**自动化与后端契约门禁全绿；B 组尚未全绿，不能上线**。阻塞在「浏览器人工项」+「B-6 功能对齐静态发现的功能缺口」

---

## 一、自动化门禁结果（全部有新鲜验证证据）

| 门禁 | 命令 | 结果 | 证据 |
|---|---|---|---|
| 快档单测 | `python tools/tests/run_all.py` | **PASS** exit 0 | 「全部通过（8 个脚本）」：test_archive_refresh / test_battery / test_erp_filter_repair / test_outbound_archive / test_pending_detail / test_ship_identity / test_source_archive / test_wms_manage。全程 [OK]，中文输出 mojibake 但无 [FAIL] |
| 前端构建 | `npm --prefix frontend run build` | **PASS** exit 0 | `tsc --noEmit && vite build`；vite 6.4.6，743 modules，built in ~6–10s。产物 `web/dist/index.html 0.75 kB`、`assets/index--61VxbJG.css 23.08 kB`、`assets/index-Pa_ShAlg.js 1,081.96 kB (gzip 348.57 kB)`（3 个文件落盘确认） |
| 集成门禁（隔离库） | `python tools/tests/smoke_test.py http://127.0.0.1:8899`（口令自动探测；亦可显式传 `admin123`） | **PASS** exit 0 | 「全部通过」，144 [OK]/0 [FAIL]，覆盖登录/权限/数据范围/订单组台账/存档/CSV 导出/组件取数 v6~v19/ERP 明细/大屏/出库归档/动力电池/WMS/预警/工时校正/看板发布等全后端契约。本轮修复脚本后连跑两次均全绿（详见六.1） |

### 构建已知告警（非阻塞）
- Vite：chunk > 500 kB（单 JS 1.08 MB / gzip 348 KB）。对应 `P4-剩余事项清单.md` §E 已知小问题；若 B-3 首屏不达标再拆 `manualChunks`。
- `features/dashboard.tsx` 同文件同时导出组件与 `usePageLayout`，Vite dev 触发 Fast Refresh 提示，生产构建无影响（§E 第 2 条）。

### 集成门禁如何做到「不动线上 / 不污染真实本地库」
- 在 `.scratch/smoke_run/` 建隔离副本（排除 .git / node_modules / .trae / frontend / __pycache__，保留 `data/backup/` 11 个 .db、`data/outbound_archive/` 32 文件、`web/dist`），覆写 `config.json` 关闭后台 ingest 扫描（source_dirs=[]、scan_sec=3600）。
- 真实 `data/dashboard.db` **仅被 SELECT 读取**：复核 `users_total=1`、`yue/clerk=0`，与验收前一致。
- 服务以 `python server.py --port 8899 --bind 127.0.0.1` 跑在隔离副本目录，数据只落 `.scratch/smoke_run/data/`，收尾已 kill。
- `git status --short` 验收后仅剩未跟踪 `.scratch/`、`.workbuddy-ai/`、`P4-剩余事项清单.md`、`deliverables/`，无已跟踪文件改动。

---

## 二、逐项验收判定

| 项 | 自动化/静态结论 | 判定 |
|---|---|---|
| **B-1 布局兼容** | 代码落点确认：`frontend/src/features/dashboard.tsx:243-277` `WidgetGrid`（`ROW_HEIGHT = 60` :44；`left: ${(widget.x / 12) * 100}%` :265；`top: widget.y * rowHeight` :266）；`usePageLayout(pageKey)` :279-293 调 `/api/pages/${pageKey}`。`layout_json {x,y,w,h,key}` 结构未变，12 列 × 60px 行绝对定位 | **待人工**：旧版(web_dir="web") vs React 打开 `/board/page/overview` 截图比对坐标 |
| **B-2 实时刷新 SSE** | 后端 `server.py:306` 路由 → `handle_sse()` :571-597 发 `event: ready` / `event: update` / `: ping` 保活；`HUB.broadcast` 遍布 data/dashboard/labor/battery/archive/alerts/startup；`db.py:708 bump_version`。前端 `frontend/src/lib/hooks.ts:37 startEventStream()`：:46 `new EventSource("/api/events")`、:50 收 `update` → :54-56 800ms 后 `queryClient.invalidateQueries()`、:58 onerror 5s 重连；`shell.tsx:138-141` 挂载 | **PASS（代码/后端）**；双窗口 5s 内刷新效果待人工 B-2 |
| **B-3 性能实测** | 首屏 < 1.5s、看板切换 < 300ms，需 DevTools Performance/Network 实测 | **待人工** |
| **B-4 权限只读账号** | `frontend/src/lib/store.ts:48-50 hasPerm()`；`frontend/src/app/shell.tsx:185` 菜单 `PAGES.filter(page => hasPerm(...))` 隐藏；`frontend/src/app/guard.tsx:7-11` 无权限返回 Empty；`frontend/src/App.tsx:102-104` 对 `must_change_pwd` 强制进 `ChangePasswordPage forced`。后端集成门禁已覆盖「只读用户改订单组/存档/用户管理/电池登记均 403」「数据范围=广东」「WMS 配置 403」 | **PASS（代码/后端）**；无金额字段/不能写/菜单隐藏待人工 B-4 |
| **B-5 浏览器兼容** | Chrome/Edge 最新两版 + 1366×768 / 1920×1080 无横向滚动，需 DevTools 设备模拟 | **待人工** |
| **B-6 功能对齐逐项** | 见下「三、B-6 静态评审发现」 | **未全绿**：存在功能缺口（部分为回归） |
| **B-7 编辑器未测分支** | 发布 / 复制组件 / 恢复默认 / 拖拽缩放 **代码均 IMPLEMENTED**；API 层由集成门禁 PASS | **PASS（代码/API）**；按钮交互待人工 |

### B-7 代码落点（已由只读评审 + 集成门禁双重确认）
- 发布：`frontend/src/pages/board.tsx:256-269` → `PUT /api/pages/${ref}` `{target:"public", layout}` + `POST /api/dashboards/${ref}/publish`；hub `dashboard.tsx:83-99`。后端 `api/dashboard_mixin.py:219-255 api_page_save`、`:98-123 api_dashboard_publish`。集成门禁 `smoke_test.py:238-242`、`:708-711` 验证 `public_version +1`。
- 复制组件：纯客户端 `board.tsx:220-225 commit([...widgets, {...widget, id: <id>-copy-<ts>, title: <title> 副本, y: widget.y+1}])`，需再点「保存」(:304) 才落库；复制整块看板 `dashboard.tsx:101-119 POST /api/boards/from-page`。
- 恢复默认：`board.tsx:271-280 POST /api/pages/${ref}/reset`（仅导航页看板，:306 `isPage &&` 门；专题看板无此入口）；后端 `api/dashboard_mixin.py:257-268 api_page_reset`。集成门禁 `:712-714` 验证 `source=="public"`。
- 拖拽/缩放：`board.tsx:317-333` 用 react-grid-layout，`compactType={null}` 自由摆放 / `preventCollision` / `draggableHandle=".dg-drag"` / `onDragStop & onResizeStop` 进历史栈；`.dg-drag` class 在 `features/dashboard.tsx:223`。与旧版 `web/grid.js:101-102` 自由摆放对齐。
- 已 PASS 分支（设置向导/撤销/重做/整理布局）读码确认存在：`board.tsx:341-398`、`:300-302`、`:122-181`；`features/widget-config.tsx:117-676 WidgetConfigModal`。

### 架构计划 §7 前端验收清单 11 项
| 项 | 判定 |
|---|---|
| 构建 `npm ci && npm run build` 成功无 TS 报错 | PASS（tsc --noEmit && vite build exit 0） |
| 产物 `web/dist/index.html + assets/*` 存在、web/dist 未提交 | PASS（3 文件；未跟踪，未提交） |
| 路由直访 `/orders /labor /admin` 刷新不 404 | 待人工（需服务端 SPA fallback 复核） |
| 浏览器 Network 无 4xx/5xx | 待人工 |
| 功能对齐 12 页逐项 | **未全绿**（见三） |
| 布局兼容 | 待人工（B-1） |
| 编辑器 拖拽缩放撤销重做整理发布复制删除 | PASS（代码/API）+ 待人工交互 |
| 大屏 轮播自动分页红条预警声音键盘 | 待人工 |
| 实时 双窗口 5s 刷新 | PASS（代码/后端）+ 待人工（B-2） |
| 性能 首屏<1.5s / 切换<300ms | 待人工（B-3） |
| 权限 只读账号 | PASS（代码/后端）+ 待人工（B-4） |
| 兼容 Chrome/Edge 两分辨率 | 待人工（B-5） |

---

## 三、B-6 静态评审发现（只读 subagent + 我独立 grep 复核）

12 导航页「筛选/排序/分页/CSV/编辑保存」逐项：`orders.tsx` 5/5 齐全；`outbound` 3/5、`battery` 3/5、`sources` 2/5、`volume/labor/alerts/audit/admin/waves` 1/5、`overview` 0/5、`dashboard(hub)` 1/5；`board/screen` 为编辑器/大屏，5 项标准不适用。多数为看板/只读/管理页，标准是否适用需验收方明确 scope。

**三个风险点**（P4 点名）：
1. `battery` 地址录入 9 字段 — **IMPLEMENTED**：`battery.tsx:47-57 DealerForm` 恰 9 字段 + `:473-494` 8 input + 地址 textarea；备件表上传 **IMPLEMENTED**：`:184-199 fetch("/api/battery/parts/import")` + `:213 file input`。与旧版逐字段对齐。
2. `labor` 工时校正 pick/check — **IMPLEMENTED**：`labor.tsx:163-204 put("pick"/"check") → PUT /api/labor/adjust`；集成门禁 `:271-280`/`:753-763` 也覆盖。
3. `waves` 乐观锁 409 — **PARTIAL**：token 在 `waves.tsx:116 expected_updated_at`，后端 409 在 `api/data_mixin.py:147-148`；但全前端 grep 无 `status === 409` 专用分支，只有通用 toast（`:122-124`），无自动刷新/重试/冲突对话框。与旧版持平，但「未测分支」不达标。

> **状态更新（2026-11-11 · Q1 补回后）**：下列第 1~4 项缺口**本轮已全部补回**（详见第七节），第 5 项属 B-7「需明确 scope」的编辑器交互说明、不属 Q1 四处缺口范围。以下保留首轮取证时的原始记录，便于追溯。

**功能缺口（按严重度，均经我独立 grep 复核）**：
1. **【回归 · 最高】`sources.tsx` WMS 自动下载面板 + 3 个导出全部缺失**。旧版 `web/app.js:4521-4717` 的 WMS 自动下载配置/定时任务/日志面板、`:4977` `/api/export/unmapped-dealers.csv`、`:4838` `/api/export/source-archive.csv`、`:4869` `/api/export/archive.csv` 在 React 版零调用。复核证据：`frontend/src` 全量 grep `download(` 仅 4 处命中（battery/orders/outbound + `lib/api.ts:69` 定义）；`grep wms-download|/api/export/(summary|archive|source-archive|unmapped-dealers|battery-archive)` 在 `frontend/src` **No matches**。后端路由仍在 `api/routes.py:93,94-100,105` 与 `api/wms_mixin.py`（集成门禁 `smoke_test.py:663-684` 已验证 WMS 配置/状态/权限全通），CSS 甚至残留 `.wms-log`（`frontend/src/styles/app.css:404`）。→ **功能从前端消失，后端能力悬空，属 React 迁移回归**。
2. **【既有缺陷】`battery` 存档模式导出错口**：`battery.tsx:229-232` 存档模式仍调 `/api/export/battery.csv`，从不调已存在的 `/api/export/battery-archive.csv`（`api/routes.py:37`、`api/export_mixin.py:84-95`）→ 存档导出可能取实时数据集。旧版 `web/app.js:3940` 同写法，非 React 回归，但仍是缺口。
3. **【回归】`overview` 汇总/打印 CSV 导出丢失**：React `overview.tsx` 仅 19 行纯 `WidgetGrid`（已读全文复核），旧版 `web/app.js:3235 /api/export/summary.csv` + `:1175` 打印单量表按钮消失。
4. **【PARTIAL】`waves` 409 无专用冲突处理**（见风险点 3）。
5. **【需明确 scope】复制组件必须再点「保存」才落库；专题看板编辑器无「恢复默认」入口（仅导航页 `isPage &&`）**。
6. **勿误判**：`waves.tsx:193 .pager` 只装「登记所选」按钮；`screen.tsx:57-89 paginate()` 是幻灯片切页；`alerts.tsx:114-115`、`volume.tsx:109-115` 的 `.filter()` 是计数/本地搜索，均非清单里的分页/筛选控件。

---

## 四、额外发现：`tools/tests/smoke_test.py` 已过期（脚本缺陷，非产品 bug）

> **状态更新（2026-11-11 追加）**：本节描述的缺陷**本轮已修复**（四问 Q2），修复内容与 fresh 验证见第六节 6.1。以下保留首轮取证时的原始记录，便于追溯「为什么当时无法全绿」。

- 真实本地 admin 口令是 `admin123`（`README.md:368` 自检示例与脚本默认 `ADMIN_PWD="Admin12345"` 已失效；`P4-剩余事项清单.md:18`「管理员默认密码已修改 pwd_is_default=0」印证；PBKDF2 直算比对 `data/dashboard.db` 确认）。
- 自提交 `080bc02 security: 强制初始口令改密` 起，`server.py:313-315` 对 `must_change_pwd` 或 `pwd_is_default` 的账号，除 `/api/logout`、`/api/change-password` 外一律返回 `428 "请先修改初始密码"`。
- `api/admin_mixin.py:40 api_user_create` 与 `:105 api_user_reset` 都置 `must_change_pwd=1`；smoke 在 `:637`/`:658` 登录 yue/clerk 后**从不调 /api/change-password**，故 `:640 /api/overview` 返回 428，实测症状 `KeyError: 'kpi'` at `smoke_test.py:641`（428 响应体 `{"error":"请先修改初始密码"}` 无 kpi 键）。→ **该脚本自 080bc02 起在任何库上都无法全绿**，但 `.trae/documents/architecture-optimization-plan.md:215` 仍写「验收：python tools/tests/smoke_test.py 全绿」，`README.md:368` 仍写默认口令用法。
- 工作流影响：为了让集成门禁拿到真实信号，我在 `.scratch/patch_smoke.py` 给**隔离副本**的 smoke_test.py 两处登录后补了 `POST /api/change-password`（Yue12345→Yue12345X、Clerk12345→Clerk12345X，改密不轮换 session，不影响后续硬编码口令检查），真实仓库 `tools/tests/smoke_test.py` 未改。
- **建议（不在本轮改，避免扩大范围）**：修 `smoke_test.py` 默认值 + 登录后改密 + 幂等清理，并同步 README/架构计划文档。此项不阻塞 B 组功能判定，但阻塞「按文档一键跑联调门禁」。

---

## 五、判定与建议

> **状态更新（2026-11-11 · Q1 补回后）**：本节「建议先决策再上线」的 B-6 四处缺口已按 Q1 裁定补回并复验（第七节），该项不再是「待决策」而是「已完成」。当前**仅剩用户 8 步浏览器人工走查**这一阻塞项；代码侧上线硬门槛已消除。以下保留首轮判定原文，便于追溯。

**B 组尚未全绿，按裁定「B 组全绿后再上线」，现在不应上线。** 阻塞分两类：

- **必须用户浏览器人工确认**：B-1 布局截图比对、B-2 双窗口 SSE、B-3 性能、B-4 只读账号、B-5 浏览器兼容，以及 §7 的路由直访/无 4xx5xx/大屏交互/编辑器按钮交互。
- **建议先决策再上线**：B-6 的 `sources.tsx` WMS 自动下载面板 + 导出回归、`overview` 汇总导出丢失、`battery` 存档导出错口、`waves` 409 无专用处理。这些是「功能对齐逐项」标准下的真实缺口，其中 `sources.tsx` 是迁移回归（后端能力悬空）。需要用户裁定：是补回前端再上线，还是把它们列为「已知未迁移、接受带缺口上线」。

### 用户浏览器人工走查清单（建议顺序）
1. 走查环境已备好并正在运行：React 版 `http://127.0.0.1:8891`、旧版基线 `http://127.0.0.1:8892`（详见 `deliverables/浏览器人工走查清单.md`；8787 被用户 Trae IDE 进程占用）。
2. **B-1**：用有已保存个人看板的旧账号，分别 `web_dir="web"`（旧版）与 React 打开 `/board/page/overview`，截图逐一比对组件 x/y/w/h。
3. **B-2**：A 窗口 `/overview`，B 窗口 `/orders` 改一行 → 观察 A 是否 5s 内自动刷新（顶栏「在线」圆点 + 时间戳）。
4. **B-3**：DevTools Performance/Network 记首屏耗时；看板页切换记耗时（标准 <1.5s / <300ms）。
5. **B-4**：新建只读账号登录，逐页查金额字段隐藏、写按钮不可用/被拒、无权限页菜单隐藏且直访给 Empty。
6. **B-5**：Chrome + Edge 最新两版，DevTools 设备模拟 1366×768 与 1920×1080，确认无横向滚动。
7. **§7 补项**：直访 `/orders /labor /admin` 刷新不 404；Network 无 4xx/5xx；大屏轮播/自动分页/红条/声音/键盘 ←→空格 Esc；编辑器拖拽缩放撤销重做整理发布复制删除按钮逐一点过（重点 409 冲突场景）。
8. **B-6 复核**：逐页对照旧版 `web/app.js` 的筛选/排序/分页/导出CSV/编辑保存；Q1 已补回的四处（`sources` WMS 面板+3 导出、`overview` 单量表 CSV+打印、`battery` 存档导出、`waves` 409 冲突处理）按「已实现、待浏览器实测」逐项点验，见第七节与走查清单第 8 步。

### 安全组（裁定：用户顺手收紧）
`P4-剩余事项清单.md` D 组：阿里云安全组 18081 从 `0.0.0.0/0` 收紧到 `183.233.190.250/32`。此项由用户执行，与 B 验收并行、互不影响。

### 收尾顺序建议
B 组人工全绿 + 缺口决策 → 用户收紧安全组 18081 → 用户执行 `deploy/deploy.ps1`（C 组上线 3 步）→ 线上回归观察 → 稳定数日后由用户执行 A 组删旧前端。

---

## 六、本轮进展（四问裁定后 · 2026-11-11 追加）

用户要求「以上问题依次提问并给多个选项（含推荐项）」，四问答案与据此完成的工作：

| 问 | 用户选择 | 本轮执行 |
|---|---|---|
| Q1 B-6 缺口决策 | **先补回全部 4 处缺口再上线（推荐）** | 记为**上线硬门槛**；本轮按 Q2 不实施补回，排到后续 |
| Q2 下一步动作 | **修 smoke_test.py 成可一键全绿（推荐）**（仅此一项） | ✅ 已完成，见下 |
| Q3 本地走查环境 | **我先把本地走查环境备好（推荐）** | ✅ 已完成，见 `deliverables/浏览器人工走查清单.md` |
| Q4 安全组 | **给我一份具体操作步骤清单（推荐）** | ✅ 已完成，见 `deliverables/安全组18081收紧操作清单.md` |

### 6.1 `tools/tests/smoke_test.py` 已修成可一键全绿（本报告第四节缺陷已消除）
- 口令默认留空时依次试 `admin123` / `Admin12345`，也可显式传第二参数；登录用同一个 Client 试，不留孤儿 session。
- 测试账号 yue/clerk 登录后先 `POST /api/change-password` 解除 P1 428 门禁再取数（`ensure_change_password()`）。
- 新增 `atexit` 幂等清理：`backup_test_users()` 备份 yue/clerk 原始状态（含权限/范围/组），`restore_test_users()` 中途异常也精确还原，不留垃圾账号。
- 文档同步：`README.md:16,368`、`.trae/documents/architecture-optimization-plan.md:215,222+` 已改为新用法 + 428 门禁说明 + 「勿对生产库跑」。
- **fresh 证据**：`py_compile` OK；隔离副本与仓库脚本 SHA256 完全相同（`310D0FA2…AD81`）证明真实未打补丁脚本可过；`python .scratch/setup_smoke.py` 重建隔离副本后起服务 8899，真实脚本连跑两次均 `144 [OK] / 0 [FAIL] / 全部通过`；`.scratch/check_cleanup.py` 复核隔离库与真实库均 `users=1, yue/clerk=0, must_change=0`，真实库未被写。
- 注意：第四节描述的「用 `.scratch/patch_smoke.py` 给隔离副本打补丁」是首轮取证手段，现已作废——仓库脚本自身已修好，`.scratch/patch_smoke.py` 勿跑。
- **后续补强（2026-11-11 · Q1 阶段，见 7.3）**：Q1 集成门禁在「干净克隆库」上又发现一处数据态依赖——候选波次取最新两个可能在途、无最终订单组号，导致台账为空、断言崩溃；本轮补 `groups>1` 优先选择后，干净库连跑两次均 `145 [OK]/0 [FAIL]/全部通过`。6.1 的 `144 [OK]` 是修复前那版脚本的记录，最终以 7.3 的 `145 [OK]` 为准。

### 6.2 本地浏览器走查环境已备好并验证（Q3）

> **更新（2026-11-11 旧前端删除后）**：`web/` 已删除，`web_dir` 改为 `dist`，走查环境重建为**单版本单一副本** `.scratch/walk_app`（端口 **8891**），旧版基线 8892 已不存在。

- 隔离副本 `.scratch/walk_app`（`web_dir=dist`，端口 **8891**），库来自真实 DB 的 `sqlite3` backup 一致性快照（含 WAL 已提交数据），关闭后台扫描，**当前正在运行**（8787 被用户 Trae IDE 进程 PID 5868 占用，故避开）。
- 重建/复验脚本：`python .scratch/setup_walkthrough.py`（重建）→ 起服务 → `python .scratch/verify_walkthrough.py`（**27 项全绿 `WALKTHROUGH_VERIFY_OK`**）。
- 只读账号 `viewer1 / Viewer12345`：`field.amount` 用 **deny 行**显式拒绝（因为 `api/startup.py:374` + `auth.ensure_presets()` 每次启动会给 viewer 补回 allow），菜单隐藏 sources/users/audit，无 428 强制改密；`admin / admin123` 保留全权限。
- 复验证据（27/27）：首页 200 且引用 `/assets/index-`；SPA 直访 `/orders`、`/print`、`/board/page/overview`、`/labor` 均 200；admin 登录含 field.amount 且无强制改密；viewer1 权限 22 项、`field.amount=False`、菜单隐藏 3 页、写操作 403、overview 金额为空；导出/WMS/归档端点全部 200（source-archives、WMS state、summary.csv、archive.csv、battery.csv、battery-archive.csv、summary 打印交叉表）；副本库保留 15 个看板、账号为 admin + viewer1。
- 8 步人工走查清单见 `deliverables/浏览器人工走查清单.md`。

### 6.3 安全组 18081 收紧操作清单（Q4）
见 `deliverables/安全组18081收紧操作清单.md`：拓扑（18081 nginx / 18082 应用 / 22 SSH）、执行前 3 项确认（办公网出口 IP、`/32`、兜底通道）、控制台 6 步、正反两面验证（办公网 200 / 非办公网超时 / SSH 通）、4 类回滚方式。由**用户执行**，我不碰云控制台。

### 6.4 结论（截至第六节）
自动化门禁全绿 + 本轮两项交付完成，但 **B 组仍未全绿、现在不应上线**：仍需①用户完成 8 步浏览器人工走查；②按 Q1 补回 B-6 四处前端缺口并复验。这两项都完成后才满足「B 组全绿后再上线」的裁定。

> **后续进展（2026-11-11 · 第七节）**：第②项「补回 B-6 四处前端缺口」已完成并通过 fresh 自动化复验（详见第七节）。**本节 6.4 结论随第七节更新为：仅剩①用户 8 步浏览器人工走查未做**——代码侧的上线硬门槛已消除。

---

## 七、Q1 四处前端缺口补回（2026-11-11 追加 · 用户指令 m00766「接着把 Q1 的四处前端缺口补回」）

按 Q1 裁定「先补回全部 4 处缺口再上线」执行，镜像旧版 `web/app.js` 行为到 React/TSX，复用现有 `download()` 与导出按钮模式，**不加任何新依赖**。缺口定义见第三节，判定标准见第五节与架构计划 §7。

### 7.1 改了什么

| # | 缺口 | 修复 | 文件 |
|---|---|---|---|
| 1 | `sources` WMS 自动下载面板 + 3 个导出缺失 | 补 WMS 面板（配置/定时任务/立即下载轮询/日志）、「每日归档」区间导出、「扫描文件归档」列表+预览+每行导出、未映射 CSV 按钮 | 新建 `frontend/src/features/wms-download.tsx`、`frontend/src/features/source-archives.tsx`；改 `frontend/src/pages/sources.tsx` |
| 2 | `overview` 汇总/打印导出丢失 | 补「导出单量表 CSV」(`/api/export/summary.csv?date=`) +「打印单量表」(`/print`) 两按钮，门 `action.export` | 改 `frontend/src/pages/overview.tsx`；新建 `frontend/src/features/summary-print.tsx`（交叉表打印页）；改 `frontend/src/App.tsx` 加 `/print` 路由（Guard `action.export`） |
| 3 | `battery` 存档导出错口 | 存档模式切 `/api/export/battery-archive.csv`，实时模式保持 `/api/export/battery.csv` | 改 `frontend/src/pages/battery.tsx:229-232` |
| 4 | `waves` 409 无专用处理 | catch 识别 `ApiError.status===409` → 专用提示 + `waves.refetch()` 刷新 +「刷新重试」按钮（从最新行取 `updated_at` 写回，保留编辑内容） | 改 `frontend/src/pages/waves.tsx` |

**必要的后端小改（支撑第 1 项）**：`api/routes.py:101-103` 增补 3 条 ROUTES 注册（`GET ^/api/source-archives$`→`api_source_archives`、`GET ^/api/export/source-archive.csv$`→`api_export_source_archive`、`GET ^/api/source-archive/(\d+)/preview$`→`api_source_archive_preview`）。handler 早已存在（`api/core_mixin.py:175/188`、`api/export_mixin.py:224`），仅遗漏 ROUTES 注册导致旧版依赖的 3 个端点 404「接口不存在」；ROUTES 总数 98→101。此为让前端导出按钮可用的必要前提，不改任何 handler 逻辑。

### 7.2 关键设计决策（与「精确镜像旧版」的差异，均为增强而非复制 bug）
- **battery 不复制旧 bug**：旧版 `web/app.js:3940` 无条件调 `battery.csv`（存档模式也如此）；React 版按模式切到正确的 `battery-archive.csv`。
- **summary.csv 归 overview**：旧版 summary.csv 实际在作业进度页、overview 只有打印入口；Q1 报告把 summary.csv 归 overview 缺口，故两样都补（CSV 更实用，打印页对齐旧版），并新增 `/print` 路由。
- **waves 409 做成增强**：旧版仅 plain toast、无 409 专用分支；React 版识别 409 + 刷新列表 + 重试按钮，优于旧版。
- **权限门对齐后端**：WMS 写操作 `action.scan`、导出 `action.export`、未映射 CSV `action.dealers.manage`、打印页 `action.export`、WMS GET `page.sources`。
- 3 个新组件零新增 CSS（复用 `.wms-log`/`.toolbar`/`.btn`/`.field`/`.tbl` 等既有类，`@media print` 已存在）。

### 7.3 额外发现并修复：`smoke_test.py` 的「在途波次」数据态崩溃（Q2 修复未覆盖）
- fresh 集成门禁在**干净克隆库**上复现崩溃：`IndexError: list index out of range` at `smoke_test.py:284 first = next(..., data["rows"][0])`。
- 根因：`candidates[:2]` 按波次号倒序盲取最新两个候选波次；今天（2026-11-11）最新几个波次是**在途波次**，明细行还没生成最终订单组号（`COUNT(DISTINCT group_no)=1`、全空串），登记它们后订单组台账 `rows=[]`，后续取 `rows[0]` 崩溃。**真实库与干净克隆库都命中**（`api_waves_candidates` 口径 `COUNT(DISTINCT group_no)`，在途波次 groups==1），即 Q2 交付的「一键全绿」在今天的数据态下实际会崩。
- 修复：`tools/tests/smoke_test.py:231-240` 优先挑 `groups>1`（有最终订单组号）的候选波次，无则退回原顺序；docstring 补充该机制。属脚本数据态健壮性修复，与 Q1 前端改动无关，但为 Q1 集成门禁提供干净证据。

### 7.4 fresh 验证证据（全部来自最终代码态 · 隔离副本 `.scratch/q1_verify`，勿对生产库跑）
- **构建**：`npm --prefix frontend run build` → exit 0（tsc --noEmit + vite v6.4.6，746 modules，7.90s，`web/dist/index.html 0.75 kB`、`index-BGqtnEjF.js 1,105.75 kB / gzip 354.09 kB`、`index--61VxbJG.css 23.08 kB`；仅既有 chunk>500kB 警告）。
- **Python**：`py_compile api/{routes,core_mixin,export_mixin,archive_mixin,wms_mixin}.py` OK；`from api.routes import ROUTES` → `ROUTES_COUNT 101`；`python tools/tests/run_all.py` → exit 0「全部通过（8 个脚本）」。
- **活服务探针 16/16 OK**（`.scratch/q1_probe.py`，端口 8899）：3 条新路由不再是路由层 404（列表 200、导出/预览为 handler 级 404「归档不存在」）；WMS state/run/log 三 GET 200；6 个导出端点 200 BOM CSV；`GET /api/summary?date=` 200（打印页取数）；**waves 过期 token → 409** 且响应体含「刚被别人修改」（前端 `ApiError.message` 可拿到）。
- **WMS 写操作 5/5 OK**（`.scratch/q1_probe2.py`）：config PUT（collect 形状）200、schedule `{action:install}` 200 `{ok:true, task:{installed:true,...}}`、两个 handler 级 404 非路由 404。
- **source-archive 真实数据 4/4 OK**（`.scratch/q1_sa_seed.py` + `q1_sa_verify.py`）：插一条含 `sheets_json/preview_json` + gz 行数据的快照后，list_archives 含该行、`export_csv` 200 且 BOM + 数据行、`preview` 200 含「发运明细」sheets。机制：`source_archive._abs(rel)=os.path.join(DATA_DIR, rel)`，故 `rows_path` 须相对 `data/` 写 `source_archive/…`。
- **集成门禁 smoke_test.py 全绿（干净克隆库）**：修复后连跑两次均 `145 [OK] / 0 [FAIL] / exit 0「全部通过」`，无 Traceback/IndexError；`py_compile` OK。
- **真实库未污染**：`.scratch/q1_check_real_db.py` → REAL `users_total=1 test_users=0 must_change=0 WAVETEST=65`（全为历史遗留且已 deleted）；所有 HTTP 写操作都打隔离 8899 库。`git status` 仅本轮预期改动：`M README.md / api/routes.py / frontend/src/{App.tsx,pages/battery.tsx,pages/overview.tsx,pages/sources.tsx,pages/waves.tsx} / tools/tests/smoke_test.py` + 未跟踪 3 个 `frontend/src/features/*.tsx`。

### 7.5 结论（更新）
- **Q1 四处前端缺口已全部补回，代码侧的上线硬门槛消除**：自动化门禁（构建 / 8 脚本单测 / 3 条新路由 / 6+2 导出 / WMS 读写 / 409 / smoke 端到端）全部 fresh 全绿。
- **仍需用户浏览器人工确认**：本报告第七节的 4 处补回属于「代码已实现」，但 B-1 布局截图比对、B-2 双窗口 SSE、B-3 性能、B-4/B-5 兼容，以及**新补功能的浏览器实测**（WMS 面板交互、各导出按钮下载、打印页打印、waves 409 冲突对话框）——这些是 `deliverables/浏览器人工走查清单.md` 8 步中的人工部分，自动化无法替代。
- 综合裁定「B 组全绿后再上线」：**代码侧已就绪，仅剩用户 8 步浏览器人工走查未做**；人工全绿 + 用户收紧安全组 18081（Q4 清单）后，方可按 C 组执行上线。
- 走查环境说明（2026-11-11 重建）：两份隔离副本 `.scratch/walk_react`/`.scratch/walk_legacy` 已按真实库一致性快照重建，两个服务**当前正在运行**于 `http://127.0.0.1:8891`（React）与 `http://127.0.0.1:8892`（旧版），可直接开浏览器点验。`.scratch/verify_walkthrough.py` 40 项全绿。8787 端口由用户自己的 Trae IDE 进程占用（跑真实库、非本轮创建，未改动）。需要完全重建时先停两个服务再执行 `python .scratch/setup_walkthrough.py`。

---

## 八、B-1 双版本截图比对（2026-11-11 追加 · 用户指令「你自己截图对比吧」，由我代跑）

> 结论先说：**B-1 专项在自动化层面已达到「布局一致」** —— 27/27 + 10/10 个看板组件的位置与尺寸与旧版**逐像素一致**（dw=dh=0，dy 为恒定 -29，仅来自页头工具栏行高）。比对过程中另发现并修掉 3 个**渲染 bug** 和 5 处**功能/入口缺失**，全部已构建通过并复测。

### 8.1 怎么做的（可复现）
- 无新依赖：本机无 playwright / selenium，改用 **Edge headless + CDP 裸协议**（Node 22+ 自带 WebSocket），驱动脚本 `.scratch/shoot.mjs`（`node shoot.mjs <plan.json> <outDir>`）。
- 同源可比：两个服务各跑一份**同库快照**（`sqlite3` backup API 取的真实库一致副本），同账号 `admin`、同业务日 `2026-11-11`、1920×1080、整页截图（`captureBeyondViewport` + clip 到内容尺寸）。
- 三类证据：①整页截图肉眼比对（12 页 × 2 版本 = 24 张，48 次采集 / 0 失败）；②DOM 探针（标题/副标题/按钮/面板/表头列数，72 项 / 0 失败）；③几何配对（`.scratch/compare_geom.py` 按标题 + 尺寸 ±3px 配对，输出 dw/dh/dx/dy）。
- 产物：**`deliverables/B-1-截图对比.html`**（12 页左右并排 + 逐页结论，图片在 `deliverables/B1-screenshots/`），用浏览器打开即可逐页看。

### 8.2 修掉的差异（本轮代码改动）
1. **看板网格行高公式错误**（这是 B-1 的主因）：旧版 `web/grid.js:13` 是 `rowHeight: 64` + 间距 `gap: 12`，React 原本按文档用 `60` 且**完全没算 12px 间距**，导致所有组件纵向被压缩 21–26%。改为 `ROW_HEIGHT=64 / ROW_GAP=12 / COLS=12`，`WidgetGrid` 用 `calc()` 复刻旧版 `pixelRect` 公式；编辑器 `board.tsx` 的 RGL `rowHeight` 同步 60→64。→ 27/27 + 10/10 尺寸一致。
2. **KPI 数值格式化错误**：`_rate` 一律按百分比处理，导致「拣货人效 44.3 行/小时」被显示成「4430.0%」；金额又出现「112.04 万万元」。按旧版 `web/app.js:2806-2826` 的 `isAmount / ratePerHour / isRate` 三分支重写 `formatKpi`。
3. **table/detail 组件不渲染表格**：后端对 table 类组件返回 `kind:"series"`，React 直接当柱状图画。新增 `TableBody`（对齐旧版 `seriesToTable`），统一 `tableCell` 格式化与 `dimensionLabel` 中文维度名。
4. **横向柱状图方向/排序反了**：补 `horizontal={categories.length > 8}`（旧版 `web/app.js:2949-2958`），并给 ECharts 类目轴加 `inverse: true`，使「由大到小、从上往下」与旧版一致。
5. **缺失入口/按钮**：overview 补「编辑布局 / 发布为全员默认 / 恢复默认 / 刷新」与副标题；labor 补「编辑布局」；sources 补「导入经销商 XLSX」「批量导入更新」（后端 `/api/dealers/import` 已支持 xlsx 与 CSV）并把面板顺序对齐旧版；dashboard 补「固定分析页」面板；battery 的「当天已登记明细」在无数据时也渲染完整 18 列表头。

### 8.3 仍存在但**有意保留**的差异（请知悉，不是缺陷）
- React 多「导出单量表 CSV」（Q1 新增能力）、多「扫描文件归档」面板与「搜索」按钮（Q1 新补；旧版该面板是死代码 `#p-scan-archives` 无容器，实际不显示）。
- 旧版页内可直接「整理布局」，React 把它收进 `/board` 编辑器（信息架构有意的收敛）；「恢复默认」仅在存在个人布局时出现。
- 「新建用户」：React 在页头工具栏，旧版在用户面板表头（位置差异，非缺失）。
- KPI 卡片视觉：旧版有左侧色条 + 标题栏，React 为标签 + 数字（重设计，几何一致）。

### 8.4 复测证据（最终代码态）
- `npm --prefix frontend run build` → exit 0（746 modules，`index-BKXCxiKD.js` 1,109.91 kB / gzip 355.31 kB）。
- 几何：`size-compatible = 27/27`（overview），`dw=dh=0`，`dy=-29` 恒定；labor 10/10 `dw=dh=dy=0`。
- DOM：`.scratch/dom_compare3.txt` —— 12 页标题全一致；volume/waves/alerts/outbound/audit/orders/battery/dashboard 面板与按钮全一致。
- 服务端：`.scratch/verify_walkthrough.py` → `40 OK / 0 FAIL`；`python tools/tests/run_all.py` → 「全部通过（8 个脚本）」。
- 截图：`.scratch/pages3/`（最终 12 页 ×2，48 OK / 0 FAIL），已拷入 `deliverables/B1-screenshots/`。

