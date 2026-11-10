# WMS 浏览器自动登录 / 按日期下载

用于外部 WMS 没有现成 API、只能在网页上“登录 → 查询页 → 输入日期 → 查询 → 导出”的场景。
脚本用 Chrome + Puppeteer 操作浏览器，Windows 任务计划定时执行；下载文件放到看板数据源目录后，看板现有扫描器会自动导入。

## 1. 前置条件

- Windows 当前用户保持登录；任务计划按“当前用户登录时运行”。
- Chrome：`C:\Program Files\Google\Chrome\Application\chrome.exe`
- Node：`C:\Users\Administrator\node-v22.23.2-win-x64\node.exe`
- Puppeteer Core：`C:\Users\Administrator\.dsh\profiles\desktop\node_modules\puppeteer-core`
- Python/openpyxl：用于下载文件表头校验（默认使用 DSH 运行时 Python）。

以上路径均可在 `wms.config.json` / `run_wms_download.bat` 中改。

## 2. 首次配置

```text
cd 看板系统\tools\wms_download
copy wms.config.example.json wms.config.json
copy secrets.local.example.json secrets.local.json
```

编辑 `wms.config.json`：至少填写 `url`、`queryUrl`（可选）、`login.*`、`query.*`、`deliverDir`。
编辑 `secrets.local.json`：填写 WMS 账号密码。**不要把 secrets.local.json 发到聊天或提交到代码库。**

### 抓取页面控件

```bat
"C:\Users\Administrator\node-v22.23.2-win-x64\node.exe" setup_capture.js --config wms.config.json
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
"C:\Users\Administrator\node-v22.23.2-win-x64\node.exe" download_wms.js --config wms.config.json --date 2026-11-05 --headed
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
- `deliverDir`：交付目录，默认 `Z:\单据登记\测试`；看板扫描器每 60 秒自动导入。
- `keepDownloadCopy`：在 `downloads/YYYY-MM-DD/` 留一份原始下载。
- `validation.requiredHeaders`：校验 Excel/CSV 必需表头；不通过不会交付。
- 同日期文件已存在：`overwriteDeliver: true` 覆盖，`false` 自动加日期后缀。

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
"C:\Users\Administrator\node-v22.23.2-win-x64\node.exe" test_local.js
```

`test_local.js` 会启动一个本地模拟 WMS 页面，验证登录、日期、查询、下载、表头校验、交付全流程，不需要真实 WMS。

## 9. 文件说明

| 文件 | 作用 |
|---|---|
| `download_wms.js` | 主脚本 |
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
