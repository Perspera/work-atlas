# WMS 自动下载 · 操作手顺

- 日期：2026-11-13（2026-11-14 增补「线上数据更新」说明）
- 配套流程图：`deliverables/wms-ingest-pipeline.html`（用浏览器打开，可缩放/点节点看细节；含「手工补数」备用路径泳道）
- 适用对象：日常看板维护人、下载机（Windows）操作人
- 性质：**操作手册**。所有命令与日志样例均取自本机 2026-11-13 17:00 / 17:10 两轮真实运行记录
- 一句话概括：**下载只能在一台装了 aTrust 的 Windows 上做，做完立刻用 HTTP 把文件推给服务器，服务器落盘后马上入库——不需要共享盘、不需要 SSH 密钥、不需要人工搬文件。**

---

## 一、先看清全貌

```
[下载机 Windows]                                    [看板服务器 8.163.57.96]
Windows 任务计划 WMS-Daily-Download
   │ 每 10 分钟（08:00–21:00）
   ▼
run_wms_download.bat
   │ chcp 65001 + 定位 node
   ▼
download_wms.js
   │ ① Chrome 无头启动，复用 profile 里的 aTrust 会话
   │ ② portal.do → 菜单 → 填订单日期 → 查询
   │ ③ 捕获 excel.do 导出表单 → 下载 xlsx
   │ ④ openpyxl 校验表头（订单日期 / 波次号）
   │ ⑤ 复制到交付目录 Z:\单据登记\测试（本地留档）
   ▼
server_push.js
   │ ⑥ POST /api/ingest/upload
   │    头：X-WMS-Token + X-File-Name
   ▼──────────────────────────────────────────────▶ nginx :18081
                                                     │ 白名单 + 32MB
                                                     ▼
                                                   /opt/work-atlas/share/xxx.xlsx
                                                     │ .part 原子落盘
                                                     ▼
                                                   ingest.scan(force=False)
                                                     │ source_files 台账
                                                     │ ship_lines 明细
                                                     │ 出库归档快照
                                                     │ bump_version → SSE
                                                     ▼
                                                   前端看板自动刷新
```

**分工**：下载机负责“拿文件 + 推文件”；服务器负责“收文件 + 入库 + 展示”。两者之间只有一条 HTTP 请求。

| 环节 | 在哪 | 出问题先看 |
|---|---|---|
| 定时触发 | 下载机任务计划 | `schtasks /Query /TN "WMS-Daily-Download"` |
| 下载 | 下载机 Chrome + aTrust | `tools/wms_download/logs/task.log` |
| 上传 | 下载机 → 服务器 | `logs/sync.log` |
| 入库 | 服务器 | 看板「数据源」页 / `source_files` 表 |

---

## 二、每天要做的三件事（日常巡检）

### 1. 看面板（30 秒）

浏览器打开看板 → 左侧「**数据源**」页 → 页面底部「**WMS 自动下载**」面板。三行关键信息：

| 位置 | 正常长什么样 | 异常信号 |
|---|---|---|
| 副标题（状态行） | `登录方式：aTrust SSO / 复用已登录会话 · 服务器同步：上传入库 http://8.163.57.96:18081/api/ingest/upload · 最近导入：…（2915 行）` | 出现「最近日志：…失败…」 |
| 上传令牌行 | `上传令牌：已配置（生成于 2026-11-13 16:22:42）· 最近上传 … 17:11:15` | 「未配置，下载机还无法上传」 |
| 定时任务状态 | `已启用 · 下次 17:20` | `未安装` / `上次结果 1` |

### 2. 看数字对不对（1 分钟）

「数据源」页上方「文件台账」里，找当天日期的 `【出库】出库流程节点时间跟踪(配送中心)-YYYY-MM-DD.xlsx`：

- 状态必须是 **ok**（不是 partial / error / unknown）
- 行数应与业务量级相符（近期参考：11-13 约 2900 行，11-12 约 3500 行）
- `导入时间` 应在最近 10 分钟内持续刷新

### 3. 看日志（有异常时）

面板右上「**查看日志**」按钮 → 弹出「WMS 下载日志（尾部 200 行）」。这是 `logs/run.log` 的尾巴，也是排错第一站。

---

## 三、首次部署（换机 / 加机器）

> 完整原理见 `tools/wms_download/README.md` 的「在一台新机器上部署」。这里只给可照抄的步骤。

### 步骤 1：准备环境（4 样，缺一不可）

| 项 | 要求 | 怎么确认 |
|---|---|---|
| Windows 账号 | **常驻登录**（任务只在用户登录时跑） | 任务计划「只在用户登录时运行」 |
| 浏览器 | Chrome 或 Edge | 装好即可，路径会自动探测 |
| Node.js | 18 及以上 | `node -v` |
| aTrust | 已登录，能打开 WMS 门户 | 浏览器手开 `https://wms.wanyouauto.com.cn/portal.do` 能进 |

再把 `tools/wms_download` 整个目录拷到新机器（或用 git 拉仓库）。

### 步骤 2：装依赖

```bat
cd <新机器>\tools\wms_download
npm install
```

机器上已有 puppeteer-core 的话可跳过，改配置里的 `puppeteerPath` 指过去。

### 步骤 3：建配置（两份）

```bat
copy wms.config.example.json wms.config.json
copy secrets.local.example.json secrets.local.json
```

`wms.config.json` **只需改这几处**，其余保持默认：

| 字段 | 填什么 | 说明 |
|---|---|---|
| `chromePath` | 新机器 Chrome 绝对路径 | 留空则按 `%LOCALAPPDATA%` → Program Files → Edge 自动探测 |
| `nodePath` | 新机器 `node.exe` 绝对路径 | 影响 bat 里的调用 |
| `puppeteerPath` | puppeteer-core 目录 | 不填则用内置默认 |
| `pythonPath` | python.exe 路径 | **不填则跳过表头校验**（不阻断下载） |
| `deliverDir` | 新机器任意本地目录，如 `D:\wms_deliver` | **不需要 Z: 共享盘** |
| `serverSync.transport` | `http` | 默认就是 http |
| `serverSync.url` | `http://8.163.57.96:18081` | 看板对外地址 |

`secrets.local.json` 填三项：

```json
{
  "username": "14127",
  "password": "<WMS 门户密码>",
  "dashboardToken": "<看板 WMS 面板生成的上传令牌>"
}
```

> **令牌全公司共用一个**。新机器不用重新生成；只有点了「重置上传令牌」才换，换了之后**所有**下载机都要更新。

### 步骤 4：先手动跑一次可见模式

```bat
node download_wms.js --config wms.config.json --headed --today
```

这一步会建立 `profile/` 里的浏览器会话（aTrust SSO 靠它复用）。成功标志（终端与 `logs/run.log` 同时出现）：

```
表头校验通过：表头 OK，数据 2915 行
文件校验通过：722485 字节
已交付：Z:\单据登记\测试\【出库】…-2026-11-13.xlsx
已同步到服务器：【出库】…-2026-11-13.xlsx（722485 字节），入库 2915 行，状态 ok
```

### 步骤 5：装定时任务

```bat
python install_task.py
```

默认任务名 `WMS-Daily-Download`，时间取 `wms.config.json` 的 `schedule`（当前 08:00–21:00 每 10 分钟）。**第二台机器起要换名字**：

```bat
python install_task.py --task WMS-Daily-Download-2
```

### 步骤 6：立刻验证一次

```bat
schtasks /Run /TN "WMS-Daily-Download"
```

然后等 2 分钟看 `logs\task.log`，应出现 `---- run start ----` … `download exit=0` … `sync exit=0`。

---

## 四、定时任务管理

| 想做什么 | 命令 |
|---|---|
| 查看任务状态 | `schtasks /Query /TN "WMS-Daily-Download" /FO LIST /V` |
| 立刻跑一轮 | `schtasks /Run /TN "WMS-Daily-Download"` |
| 暂停（保留配置） | `schtasks /Change /TN "WMS-Daily-Download" /DISABLE` |
| 恢复 | `schtasks /Change /TN "WMS-Daily-Download" /ENABLE` |
| 改时间/间隔 | 改 `wms.config.json` 的 `schedule` → `python install_task.py`（覆盖重装） |
| 卸载 | `python install_task.py --remove` 或 `uninstall_task.ps1` |

也可以直接用面板按钮：**启用定时任务 / 更新定时任务 / 暂停 / 移除任务**（面板改的是同一份 `wms.config.json`）。

**注意**：面板上的这些按钮在**线上服务器**是灰的（Linux 上管不了 Windows 任务），只有在下载机本机开面板才能点。

---

## 五、手动操作

### 1. 立即下载一轮（不等定时器）

面板 →「**立即下载**」。等价命令：

```bat
cd tools\wms_download
node download_wms.js --config wms.config.json
```

按日期指定：

```bat
node download_wms.js --config wms.config.json --date 2026-11-12
node download_wms.js --config wms.config.json --yesterday
```

### 2. 只把交付目录里已有的文件补传上去（不下载）

面板 →「**补传服务器**」。等价命令：

```bat
node sync_to_server.js --config wms.config.json
```

先看会传哪些（不真传）：

```bat
node sync_to_server.js --config wms.config.json --dry-run
```

### 3. 补传单个指定文件

```bat
node download_wms.js --config wms.config.json --sync-file "Z:\单据登记\测试\【出库】…-2026-11-12.xlsx"
```

### 4. 本地自检（改完配置/换机器后跑）

```bat
node test_local.js
```

5 项全 OK 才算环境正常。

---

## 六、上传令牌管理

| 场景 | 操作 |
|---|---|
| 首次部署 | 面板点「**生成上传令牌**」→ 弹窗里复制 → 粘到下载机 `secrets.local.json` 的 `dashboardToken` |
| 令牌泄露 / 换人 | 面板点「**重置上传令牌**」→ 复制新令牌 → **每台**下载机都更新 |
| 忘记是否配过 | 面板「上传令牌」行显示「已配置（生成于 …）」即已配 |

要点：
- 令牌**只在生成时显示一次**，关掉弹窗就看不到了，只能重置。
- 令牌只以 sha256 存在服务器 `meta` 表里，不会明文落库。
- 重置后旧令牌**立刻失效**，下载机会上传失败（`401 上传令牌不正确`），必须同步更新。

---

## 七、日志与排错

### 1. 五个日志各管什么（排错先分清）

| 文件 | 谁写 | 看它解决什么 |
|---|---|---|
| `logs/task.log` | `run_wms_download.bat` | **整轮调度**：每轮起止、`download exit=N`、`sync exit=N` |
| `logs/run.log` | `download_wms.js` | **下载细节**：每一步点到了什么、下载多少字节、校验结果 |
| `logs/sync.log` | `sync_to_server.js` | **上传细节**：目标地址、传了哪个文件、入库多少行 |
| `logs/sync-state.json` | `sync_to_server.js` | 去重状态（键 = 名称\|大小\|mtime） |
| `logs/ui-run-<时间>.log` | 后端 `wms_manage.start_run` | 面板点「立即下载」时的独立日志 |

另有两类现场文件：
- `logs/fail-<时间戳>.png` / `.html` —— 下载失败时的截图与页面 HTML，**排页面改版类问题最有用**
- `logs/profile/` —— 浏览器会话目录，删了要重新登录一次

### 2. 常见故障对照表

| 现象 / 日志关键字 | 根因 | 处置 |
|---|---|---|
| `net::ERR_CONNECTION_TIMED_OUT` + 日志「等待 WMS 门户加载超时（检查 VPN/SSO 是否登录）」 | **aTrust 掉线**（最常见） | 手动登录 aTrust，再 `schtasks /Run` |
| `页面出现验证码，自动登录无法继续` | WMS 要求验证码 | 用 `--headed` 人工登录一次，profile 会保存会话 |
| `未找到账号配置：…secrets.local.json` | 缺 `secrets.local.json` | 复制 example 并填写 |
| `Chrome 不存在：…` | `chromePath` 不对且自动探测失败 | 配置里写绝对路径 |
| `无法加载 puppeteer-core：…` | 没 `npm install` 或 `puppeteerPath` 错 | 装依赖或改路径 |
| `上传失败（HTTP 401）：上传令牌不正确` | 令牌被重置或填错 | 面板重新生成 → 更新所有下载机 |
| `上传失败（HTTP 503）：未配置上传令牌` | 服务器还没生成过令牌 | 面板点「生成上传令牌」 |
| `上传失败（HTTP 413）` | 文件超 32MB（当前报表 0.2–1.2MB，几乎不会） | 检查 nginx `client_max_body_size` |
| 上传超时 / 连接被拒 | 本机出口 IP 不在 nginx 白名单 | 改 `deploy/nginx-work-atlas.conf` 的 `allow` 行 |
| `点击菜单后没有出现查询页` | WMS 页面改版 | 重跑 `node setup_capture.js` 重新抓控件 |
| `查询结果为空（页面显示空态），不下载` | 当天还没数据（正常） | 无需处理，等下一轮 |
| `已有下载任务在运行（PID n）` | 上一轮还没结束 | 等它结束，别并发 |
| 面板「查看日志」空白 | `run.log` 还没写或权限问题 | 直接看 `logs\run.log` |
| 面板按钮全灰 + 提示「当前是线上服务器（Linux）」 | 打开的是服务器版面板 | 到下载机本机开面板，或用命令行 |

### 3. 一次正常运行的日志长什么样（17:10 那轮实录，可直接对照）

```
[周五 2026/11/13 17:10:00.96] ---- run start ----
[2026-11-13 17:10:01] 本次查询日期：2026-11-13
[2026-11-13 17:10:01] 临时下载目录：D:\newapp\projects\work-atlas\tools\wms_download\downloads\tmp
[2026-11-13 17:10:01] 交付目录：Z:\单据登记\测试
[2026-11-13 17:10:04] 启动 Chrome（无头），profile：…\tools\wms_download\profile
[2026-11-13 17:10:04] 打开页面：https://wms.wanyouauto.com.cn/portal.do
[2026-11-13 17:10:10] login.skip=true，跳过登录（使用 WMS 门户/SSO 已登录会话）
[2026-11-13 17:10:12] 已点击菜单（第 1 次）：【出库】出库流程节点时间跟踪(配送中心)
[2026-11-13 17:10:13] 填写查询日期：2026-11-13
[2026-11-13 17:10:13] 点击查询
[2026-11-13 17:10:39] 点击下载/导出
[2026-11-13 17:10:40] 导出列已选：39 行
[2026-11-13 17:10:40] 捕获导出表单：https://wms.wanyouauto.com.cn/excel.do（22 个字段）
[2026-11-13 17:11:08] 导出文件已保存：【出库】…-2026-11-13.xlsx（722485 字节，…spreadsheetml.sheet;charset=utf-8）
[2026-11-13 17:11:10] 表头校验通过：表头 OK，数据 2915 行
[2026-11-13 17:11:10] 文件校验通过：722485 字节
[2026-11-13 17:11:10] 已交付：Z:\单据登记\测试\【出库】…-2026-11-13.xlsx
[2026-11-13 17:11:10] 上传 【出库】…-2026-11-13.xlsx（722485 字节）→ http://8.163.57.96:18081/api/ingest/upload
[2026-11-13 17:11:14] 已同步到服务器：…（722485 字节），入库 2915 行，状态 ok
[周五 2026/11/13 17:11:15.12] download exit=0
[2026-11-13 17:11:15] 目标：http://8.163.57.96:18081/api/ingest/upload
[2026-11-13 17:11:15] 交付目录：Z:\单据登记\测试，候选 5 个
[2026-11-13 17:11:15] 完成：…（722485 字节），入库 2915 行，状态 ok
[2026-11-13 17:11:15] 同步结束：上传 1 个，跳过 4 个，失败 0 个
[周五 2026/11/13 17:11:15.37] sync exit=0
```

**判读要点**：
- 全轮约 75–80 秒（门户打开 ~6s、查询 ~26s、导出 ~28s、上传 ~4s）
- `download exit=0` 与 `sync exit=0` 都为 0 才算完全成功
- 「跳过 4 个」是去重生效（交付目录里有 5 个文件，只有 1 个是新的），**不是错误**
- 重复上传同一内容时，服务器会直接返回 `skipped`，不重扫、不涨版本号

### 4. 失败时它会不会断数据？

不会。`run_wms_download.bat` 里**上传是无条件执行**的——即使下载失败（`download exit=1`），仍会跑一轮 `sync_to_server.js`，把交付目录里已有的文件补传上去。所以 aTrust 掉线时，之前下载好的文件仍能入库。

---

## 八、服务器侧（需要时）

### 1. 健康检查

```bash
curl http://127.0.0.1:18082/api/health      # 服务器上执行，期望 {"ok": true, "time": "..."}
systemctl is-active work-atlas              # 期望 active
```

外部入口（办公网内）：

```bash
curl http://8.163.57.96:18081/api/health
```

`deploy/healthcheck.sh` 已由 cron 每 5 分钟跑：连续失败 3 次写 `/var/log/work-atlas-alert.log`，之后每小时追加一条，恢复时补一条恢复记录。

### 2. 看入库结果

```bash
# 数据源目录（下载机传上来的文件都在这）
ls -lh /opt/work-atlas/share

# 最近导入的台账
sqlite3 /opt/work-atlas/shared/data/dashboard.db \
  "SELECT name,rows,status,imported_at FROM source_files ORDER BY imported_at DESC LIMIT 5;"
```

### 3. 发版与回滚

```powershell
# 发版（本机执行）
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\deploy.ps1
```

脚本会：打前端 → 打包 → scp → 解包到 `releases/<时间戳>` → 装依赖 → 切 `current` 软链 → 重启 → 30 次健康检查 → 失败自动回滚 → 只保留 5 个版本。

手工回滚：

```bash
ssh root@8.163.57.96 \
  'ln -sfn /opt/work-atlas/releases/<上一版本> /opt/work-atlas/current && systemctl restart work-atlas'
```

### 4. 线上数据怎么更新（三种方式）

线上只扫**一个**目录 `/opt/work-atlas/share`（`config.json` 的 `prod.source_dirs`），每 60 秒一轮；同一天的导出重新覆盖会**就地更新**，不重复累计。

| 方式 | 在哪操作 | 生效时间 | 适用 |
|---|---|---|---|
| 自动（推荐） | 下载机任务计划 `WMS-Daily-Download`（08:00–21:00 每 10 分钟） | 下一轮 | 日常 |
| 手动补传 | 下载机面板「补传服务器」或 `node sync_to_server.js --config wms.config.json` | 立即（上传接口同步入库） | aTrust 掉线后补数、补历史文件 |
| 直接放文件 | 任意能 SSH 的机器 `scp 文件 root@8.163.57.96:/opt/work-atlas/share/`，再看板点「立即扫描」 | ≤60 秒 | 临时手工导出 |

补充说明：

- **发版不影响数据**：`deploy/deploy.ps1` 只切 `releases/<时间戳>` 代码目录，各版本里的 `data` 都软链到 `/opt/work-atlas/shared/data`，业务库、归档、备份都保留。
- **服务器不能自己下载 WMS**：SSO 登录页在内网 `10.8.255.70:18080`，云服务器没有 aTrust；所以「立即下载」「补传服务器」「启用/更新定时任务」只能在下载机的看板上点，线上服务器点会返回 400。
- **看板页面没有原始数据文件上传入口**（只有经销商映射 CSV/XLSX 导入），发运表/运输单状态文件只能走上面三条路径。
- 手工放文件后如果不想等扫描，在「数据源」页点「立即扫描」即可；页面上的「上次扫描」「数据覆盖范围」「文件台账状态」可用于确认。

### 5. nginx 配置（改白名单 / 改上传上限时）

```bash
vi /etc/nginx/conf.d/work-atlas.conf
nginx -t && systemctl reload nginx
```

两个关键行：
- `client_max_body_size 32m;` —— 不设会按默认 1MB 截断，上传大报表直接 413
- `allow 183.233.190.250;` —— 公司出口 IP，**出口变了必须同步改这一行**，否则全公司访问不了

---

## 九、变更与运维注意事项

1. **aTrust 是唯一的人工依赖**。掉线 → 下载失败（但补传仍工作）。长期无人值守方案需要 aTrust 支持会话保活，目前没有。
2. **`.scratch` 与 `logs`/`downloads`/`profile` 不进发布包**。`deploy/deploy.ps1` 的 tar 排除清单已包含，勿删。
3. **`deploy/deploy.ps1` 必须保持 UTF-8 with BOM**。无 BOM 时 PowerShell 解析会报「标记"||"不是有效语句分隔符」。
4. **`run_wms_download.bat` 必须保持 CRLF**。LF 会导致 `exit=1` 且 `task.log` 为空。
5. **改 `config.json` 必须重启服务**（配置在进程启动时加载一次）。
6. **多台下载机同时传同名文件**：后到覆盖先到；内容 sha 相同则跳过，不会重复入库。
7. **同机不要并发跑两个实例**：脚本用 `.wms_download.lock` 做了单实例保护，第二个会报 `已有下载任务在运行`。
8. **发布包不要带 `secrets.local.json`**：已在 `.gitignore` 与 tar 排除清单里，确认别手工加进去。

---

## 十、一页速查

```
日常：开看板 → 数据源页 → WMS 面板看三行（状态/令牌/任务） → 文件台账看当天行数
巡检：logs\task.log 最后 20 行，两个 exit 都是 0 就正常
失败：先看是不是 aTrust 掉线（最常见），再看 logs\fail-*.png 是否页面改版
补数：面板「补传服务器」，或 node sync_to_server.js --config wms.config.json
线上数据：下载机自动上传 → /opt/work-atlas/share → 60 秒扫描入库；手工 scp 后点「立即扫描」
换机：拷目录 → npm install → 改 4 个路径 + deliverDir + url → 填 dashboardToken → --headed 跑一次 → install_task.py
发版：deploy\deploy.ps1（失败自动回滚）
```
