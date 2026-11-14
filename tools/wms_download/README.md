# WMS 浏览器自动登录 / 按日期下载

用于外部 WMS 没有现成 API、只能在网页上“登录 → 查询页 → 输入日期 → 查询 → 导出”的场景。
脚本用 Chrome + Puppeteer 操作浏览器，Windows 任务计划定时执行；下载后直接 HTTP 上传给看板（服务器落盘后立即入库），无需人工搬运文件。

## 1. 前置条件

- Windows 当前用户保持登录；任务计划按“当前用户登录时运行”。
- Chrome：脚本会按 `config.chromePath` → `CHROME_PATH` → `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe` → `C:\Program Files\Google\Chrome\Application\chrome.exe` → `Program Files (x86)` → `msedge.exe` 依次探测，所以换机器一般不用改配置。
- Node：`run_wms_download.bat` 里默认 `F:\APP\dev_env\Node.js\node.exe`，找不到时回退 `C:\Program Files\nodejs\node.exe`、再回退 PATH 里的 `node`。
- Puppeteer Core：`C:\Users\Administrator\.dsh\profiles\desktop\node_modules\puppeteer-core`（也可写 `puppeteerPath`）。
- Python/openpyxl：用于下载文件表头校验（默认使用 DSH 运行时 Python，见 `pythonPath`）。
- 送文件到服务器：默认走 HTTP 上传（`serverSync.transport=http`），只需本机能访问看板 `url`，并在 `secrets.local.json` 填看板生成的上传令牌 `dashboardToken`；若改用 `transport=scp` 才需要本机能 `ssh root@8.163.57.96` 免密登录（`scp.exe`/`ssh.exe` 在 `C:\Windows\System32\OpenSSH\`）。

以上路径均可在 `wms.config.json` / `run_wms_download.bat` 中改。

如果本机没有现成的 puppeteer-core，可用本目录的 `package.json` 自带安装：

```bat
cd 看板系统\tools\wms_download
npm install
```

装好后把 `PUPPETEER_CORE_PATH` 环境变量指向 `tools\wms_download\node_modules\puppeteer-core` 的**绝对路径**，
或把该路径写进 `wms.config.json` 的 `puppeteerPath` 字段。

## 2. 首次配置

```text
cd 看板系统\tools\wms_download
copy wms.config.example.json wms.config.json
copy secrets.local.example.json secrets.local.json
```

编辑 `wms.config.json`：至少填写 `url`、`queryUrl`（可选）、`login.*`、`query.*`、`deliverDir`。
编辑 `secrets.local.json`：填写 WMS 账号密码。**不要把 secrets.local.json 发到聊天或提交到代码库。**

### 在一台新机器上部署（换机 / 加机器）

整条链路里只有“下载”这一步依赖本机环境，其余都在服务器。新机器按下面顺序做一遍即可：

1. **准备环境**（缺一不可）
   - Windows 上装好 Chrome（或 Edge），并确认该账号**常驻登录**（任务只在用户登录时跑）。
   - 装 Node.js 18+，记下 `node.exe` 绝对路径。
   - 装 aTrust 并**手动登录一次**，浏览器能打开 `https://wms.wanyouauto.com.cn/portal.do`。
   - 把整个 `tools/wms_download` 目录拷到新机器（或从 git 拉仓库）。
2. **装依赖**：`cd tools\wms_download && npm install`（装 `puppeteer-core`）。
   若机器上已有 puppeteer-core，可不装，改 `wms.config.json` 的 `puppeteerPath` 指过去。
3. **建配置**：`copy wms.config.example.json wms.config.json`、`copy secrets.local.example.json secrets.local.json`，
   然后改这几处（其余保持默认即可）：
   - `chromePath` / `nodePath` / `puppeteerPath` / `pythonPath`：新机器上的真实路径（Chrome、Node 可留空让脚本自动探测）。
   - `deliverDir`：新机器上的任意本地目录，例如 `D:\\wms_deliver`（不需要共享盘）。
   - `serverSync.url`：`http://8.163.57.96:18081`；`serverSync.transport`：`http`。
   - `secrets.local.json` 的 `dashboardToken`：看板「WMS 自动下载」面板里生成的上传令牌（**全公司共用同一个令牌**，
     不需要在新机器上再生成；只有点“重置”才会换）。同一文件里也填 WMS 门户账号密码（`login.skip=true` 时可留空）。
4. **跑一次可见模式**，让 profile 建立会话并确认选择器可用：
   ```bat
   node download_wms.js --config wms.config.json --headed --today
   ```
   成功标志：日志出现「表头校验通过 / 已交付 / 已同步到服务器…入库 N 行」。
5. **装定时任务**：
   ```bat
   python install_task.py
   ```
   任务名默认 `WMS-Daily-Download`，按 `wms.config.json` 的 `schedule` 生效（当前：每天 08:00–21:00 每 10 分钟）。
   立刻验证一次：`schtasks /Run /TN "WMS-Daily-Download"`，然后看 `logs\task.log`。
6. **多台机器并存注意**
   - 任务名相同会互相覆盖，第二台起请用 `python install_task.py --task WMS-Daily-Download-2` 换个名字。
   - 上传令牌是全公司一个，多台机器可以共用；但**同一台机器**不要并发跑两个实例（脚本有 `.wms_download.lock` 单实例锁）。
   - 多台机器都会往同一个 `/opt/work-atlas/share` 上传同名文件时，后到的覆盖先到的；服务器侧按内容 sha 判断，
     内容相同会直接跳过，不会重复入库。

### 抓取页面控件

```bat
node setup_capture.js --config wms.config.json
```

脚本会打开可见 Chrome：

1. 手动登录；
2. 进入查询页面；
3. 回到命令行按 Enter。

随后在 `logs/setup-*.controls.json`、`logs/setup-*.png`、`logs/setup-*.html` 中查看控件与页面现场，把选择器填进配置：

- `login.username/password/submit/success`
- `query.dateInput/search/result/empty/download`

`search` / `download` 可以写 `{ "text": "查询" }`，按页面文字找按钮；页面改版时只改配置。

## 3. 手动试跑（真实 WMS 已验证）

当前 WMS 配置：门户 `https://wms.wanyouauto.com.cn/portal.do`，通过 aTrust SSO 自动登录；
菜单「【出库】出库流程节点时间跟踪(配送中心)」；查询日期字段 `2026-11-06`；
导出走「导出设置 → 所有过滤数据 → 导出」，脚本直接捕获 excel.do 表单下载。

```bat
node download_wms.js --config wms.config.json --date 2026-11-05 --headed
```

或：

```bat
run_wms_download.bat --yesterday
```

成功标志：日志出现“下载完成 / 表头校验通过 / 已交付”，文件出现在 `deliverDir`。
完整日志在 `logs/run.log`，失败截图在 `logs/fail-*.png`。

## 4. 日期模式

- `dateMode: "yesterday"`（默认，早上跑昨天）
- `"today"`
- `"fixed"` + `fixedDate: "2026-11-05"`
- `"relative"` + `relativeDays: -2`（相对今天）
- 命令行覆盖：`--date 2026-11-05`、`--today`、`--yesterday`

## 5. 下载与交付

- `downloadDir`：临时下载目录（每轮清空，避免把旧文件当新文件）。
- `deliverDir`：交付目录，默认 `Z:\单据登记\测试`；只是本地留档，交付后随即上传服务器入库（见 5.1）。换成新机器时可改成该机任意本地目录，例如 `D:\wms_deliver`。
- `keepDownloadCopy`：在 `downloads/YYYY-MM-DD/` 留一份原始下载。
- `validation.requiredHeaders`：校验 Excel/CSV 必需表头；不通过不会交付。
- 同日期文件已存在：`overwriteDeliver: true` 覆盖，`false` 自动加日期后缀。

## 5.1 把文件送到服务器（serverSync）

线上看板（`WORK_ATLAS_ENV=prod`）只扫 `/opt/work-atlas/share`。WMS 的 SSO 登录页在内网
（`10.8.255.70:18080`），阿里云服务器访问不到，所以下载必须在装了 aTrust 且已登录的 Windows 机器上执行，
下载完再把文件送到服务器。**两种通道**，用 `serverSync.transport` 选：

```json
"serverSync": {
  "transport": "http",
  "url": "http://8.163.57.96:18081",
  "target": "root@8.163.57.96",
  "remoteDir": "/opt/work-atlas/share",
  "scpPath": "C:\\Windows\\System32\\OpenSSH\\scp.exe",
  "sshPath": "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
  "timeoutMs": 120000,
  "required": true,
  "namePattern": "出库流程节点时间跟踪",
  "maxFiles": 5
}
```

- **`transport: "http"`（默认，推荐）**：把文件 POST 到看板的 `POST /api/ingest/upload`，服务器落到
  `source_dirs` 第一个目录（prod 即 `/opt/work-atlas/share`）后**立即扫描入库**，响应里带回导入行数。
  不需要免密 SSH，只需要能访问 `url`；请求头 `X-WMS-Token` 是看板「WMS 自动下载」面板生成的上传令牌。
- **`transport: "scp"`**：旧通道，`scp` 上传到 `target:remoteDir` + `ssh stat -c %s` 校验字节数，
  靠看板每 60 秒自动扫描导入；需要本机能免密 `ssh root@8.163.57.96`。
- 也可以不用本工具：手工把文件 `scp` 到 `/opt/work-atlas/share`，看板 60 秒内自动扫描（不需要上传令牌）；急用就在「数据源」页点「立即扫描」。
- 上传令牌填在 `secrets.local.json` 的 `dashboardToken`（该文件被 `.gitignore` 忽略，不要提交）：

```json
{
  "username": "14127",
  "password": "WMS 门户密码",
  "dashboardToken": "看板面板生成的令牌"
}
```

- 令牌在数据库里只存 sha256；面板点「重置上传令牌」后旧令牌立即失效，需要同步更新下载机的 `secrets.local.json`。
- `download_wms.js` 交付成功后自动调 `pushToServer()`。
- `run_wms_download.bat` 在下载之后**无条件**再跑一次 `sync_to_server.js`：即使下载失败（例如 aTrust 掉线），
  也会把交付目录里新出现的文件补传上去——文件可能是人工或别的机器放进来的。
- `sync_to_server.js` 单独用法：

```bat
node sync_to_server.js --config wms.config.json            # 同步最新 5 个
node sync_to_server.js --config wms.config.json --all      # 忽略状态文件，全部重传
node sync_to_server.js --config wms.config.json --dry-run  # 只看要传哪些
node download_wms.js --config wms.config.json --sync-file "Z:\单据登记\测试\xxx.xlsx"   # 只补传指定文件
```

- 去重状态在 `logs/sync-state.json`，键是「文件名|字节数|mtime」，所以文件内容更新（大小或时间变）会重新上传。
- 上传/同步失败的详细日志在 `logs/sync.log`；`required: true` 时同步失败会让整轮任务返回非 0。
- 服务器侧落盘用「先写 `.part-*` 再 `os.replace`」，扫描器不会读到半截文件；内容与已有文件完全一致时直接跳过，不重扫。

## 6. 定时执行（频次/间隔可自定义）

配置在 `wms.config.json` 的 `schedule` 中，也可以安装时用参数覆盖：

```json
"schedule": {
  "mode": "daily",
  "times": ["08:30", "14:00"],
  "intervalMinutes": 60,
  "startTime": "08:30"
}
```

- 每天固定时间（可多个）：`"mode": "daily", "times": ["08:30", "14:00"]`
- 每天 08:00–21:00 每 10 分钟（当前已使用）：
  `"mode": "interval", "intervalMinutes": 10, "startTime": "08:00", "endTime": "21:00"`
- 每隔 N 分钟（全天）：`"mode": "interval", "intervalMinutes": 60, "startTime": "08:30", "endTime": "23:00"`
- 安装脚本默认读取配置；也可直接指定：

```powershell
# 每天 08:30、14:00
.\install_task.ps1 -Mode daily -Times "08:30,14:00"

# 每天 08:00–21:00 每 10 分钟（推荐用 Python 安装器，路径/中文目录更稳）
python install_task.py
# 或：
.\install_task.ps1 -Mode interval -IntervalMinutes 10 -StartTime 08:00 -EndTime 21:00
```

手动触发验证：

```bat
schtasks /Run /TN "WMS-Daily-Download"
```

删除任务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File uninstall_task.ps1
```

> 每次任务查询的“日期”由 `dateMode` 决定（昨天/今天/固定/相对），与执行频次独立。
> 任务只在当前用户登录时运行；电脑注销/未登录不会跑。若需要关机也执行，需要另配服务账号/自动登录，不建议。

## 7. 验证码 / 企业 SSO

- 有验证码、短信、MFA 时，**无法完全无人值守**。处理方式：
  - 用可见模式手动登录一次，profile（`profile/` 目录）会保留会话；
  - 任务只复用有效会话；失效时脚本保存截图并退出，提示人工处理；
  - 不要在脚本里写破解验证码逻辑。
- 如果 WMS 只支持 IE/360 兼容模式，Chrome 自动化可能无法渲染页面；需要改用 Edge IE 模式或桌面 UI 自动化，另行评估。

## 8. 本地自测

```bat
node test_local.js
```

`test_local.js` 会启动一个本地模拟 WMS 页面，验证登录、日期、查询、下载、表头校验、交付全流程，不需要真实 WMS。

## 9. 文件说明

| 文件 | 作用 |
|---|---|
| `download_wms.js` | 主脚本（下载 → 校验 → 交付 → 上传入库） |
| `server_push.js` | 送文件到服务器的公共模块：`http` 上传 / `scp` 上传两种通道 |
| `sync_to_server.js` | 扫描 `deliverDir`，把新文件补传服务器（默认 HTTP 上传即入库） |
| `setup_capture.js` | 首次抓控件 |
| `validate_download.py` | 下载文件表头/行数校验 |
| `wms.config.example.json` | 配置样例 |
| `secrets.local.example.json` | 账号样例（实际 secrets 不要提交） |
| `run_wms_download.bat` | 任务计划入口 |
| `install_task.ps1` / `uninstall_task.ps1` | 安装/删除计划任务 |
| `test_fixture.html` / `test_local.js` | 本地模拟 WMS 测试 |

## 10. 注意

- 本脚本面向**已授权的内部系统**；账号密码只放本机受限文件。
- 页面改版导致选择器失效时，重跑 `setup_capture.js` 并更新配置，不改主脚本。
- 下载失败不会把半截文件放入看板数据目录；失败现场会留截图/HTML 供排查。
