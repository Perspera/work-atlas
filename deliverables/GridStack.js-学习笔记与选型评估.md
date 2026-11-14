# GridStack.js 学习笔记与应用评估

> 文档类型：技术学习笔记 + 选型评估（**不含代码改动**）
> 评估基线：`main` @ `ae85df0`（2026-11-14），本机已装 `gridstack@14.1.0`、`react-grid-layout@1.5.4`
> 原文：《前端人赢麻了！这个 JS 库火了！拖拽就能做可视化大屏》— 前端Hardy，2026-10-04
> 原文链接：https://mp.weixin.qq.com/s/jIfKmTLSESgqMBsM2jGHYQ
> 官网：https://gridstackjs.com/ ｜ 源码：https://github.com/gridstack/gridstack.js

## 0. 一句话结论

**现在不迁移。** 现有 `react-grid-layout` 编辑器已经覆盖本项目"拖拽/缩放/自由摆放 + 保存/发布 + 版本控制"的核心诉求；
GridStack 值得关注的能力（Nested Grid、跨 Grid 拖拽、打印排版、开箱的触摸与自动重排）目前都没有明确业务需求，
且真正落地要同时改编辑器 + 只读渲染一致性 + 回归验收，性价比不高。等出现第 6 节的触发条件，再做 PoC 或迁移。

---

## 1. 文章要点

### 1.1 文章讲了什么

面向"后台管理系统 / 数据大屏 / SaaS 平台"里"让用户自己拖动、调整、排列页面上的组件"这个看起来简单、做起来麻烦的需求，
推荐开源库 **GridStack.js**，并强调它把常被低估的细节都做了：拖拽、碰撞、缩放、响应式、布局保存。

### 1.2 文章给出的最小示例

```ts
const grid = GridStack.init();
grid.load([
  { content: "第一个组件" },
  { w: 2, content: "第二个组件" },
]);
```

得到：拖动 + 缩放 + 自动排列，且布局可保存、下次打开保持原位置。

### 1.3 文章强调的能力清单

| # | 文章说法 | 对应技术点 |
|---|---|---|
| 1 | 拖一拖，组件自己排 | `GridStack.init()` + `load()`，默认 12 列栅格自动重排 |
| 2 | 布局可保存、下次打开保持 | `grid.save()` / `grid.load()` |
| 3 | 跨 Grid 拖拽（Inter-grid Drag & Drop） | `GridStackOptions.acceptWidgets`、多 Grid 实例 |
| 4 | Nested Grids（Grid 里再放 Grid） | `GridStackOptions.subGridOpts` / `GridStackWidget.subGridOpts` |
| 5 | 响应式：桌面 12 列、平板 8 列、手机 1~2 列 | `GridStackOptions.columnOpts: { breakpoints: [{ w, c }], columnWidth, columnMax }` |
| 6 | 移动端触摸操作 | `dd-touch`（库内置），`columnOpts` 断点配合 |
| 7 | React / Vue / Angular 都能用 | 官方 wrapper（React 版随主包发布为 `gridstack/dist/react`） |
| 8 | 动态增删 Widget、打印、RTL、多 Grid 交互 | `addWidget`/`removeWidget`、`PrintOptions`、RTL 支持 |

文章还提到 13.3.0 版本加入"移动端拖动/滚动行为优化、更完善的打印能力"，并把它定位为完整的 **Dashboard Layout Engine**。
文章最后给了一个判断标准：只做简单拖拽卡片可以自己写；一旦需求叠加成
"拖拽 + 缩放 + 响应式 + 布局保存 + 跨 Grid + Nested Grid + 移动端"，就该用库。

---

## 2. 事实核查（对照本机 `frontend/node_modules/gridstack@14.1.0`）

公众号文章是推广文，部分说法需要按实际安装版本核对。结论：**文章主体属实；有一处过时口径、三点补充事实**。

| 文章说法 | 本地核查 | 证据 |
|---|---|---|
| "npm install gridstack 即可" | 已安装，且就是当前 npm 最新版 14.1.0 | `frontend/package.json:15`；npm registry `gridstack/latest` = 14.1.0 |
| "TypeScript 网格布局库" | 属实：纯 TS 实现，零运行时依赖（`dependencies: {}`，README 自称 "no external dependencies"） | `gridstack/package.json` 的 `dependencies`；`README.md:7` |
| "官方提供 React 支持" | 属实：React wrapper 在主包内，`gridstack/dist/react`，含 `<GridStack options components>`、`useGridStack()`（`grid` / `addWidget` / `removeWidget` / `save`）、`useWidgetSerializer`、`GridStackItem` | `gridstack/dist/react/README.md`、`dist/react/index.d.ts`、`dist/react/hooks.d.ts` |
| "布局保存与恢复" | 属实：`grid.save(saveContent?, saveGridOpt?, saveCB?, column?)` 返回 widget 列表；`grid.load(items, addRemove?)` 恢复；默认保存"最大的布局"以便各断点都能恢复 | `dist/gridstack.d.ts` 的 `save` / `load` 注释 |
| "响应式断点：12/8/1~2 列" | 属实：`columnOpts.breakpoints: [{ w, c }]`、`columnWidth`、`columnMax`、`breakpointForWindow`；注意 **v10 起单列模式默认关闭**，必须显式配置 `columnOpts` | `dist/types.d.ts` 的 `Responsive` / `Breakpoint`；`README.md:475-480` |
| "跨 Grid、Nested Grid" | 属实：`acceptWidgets` + `subGridOpts`，React wrapper 同样支持 | `dist/types.d.ts` 的 `acceptWidgets` / `subGridOpts` |
| "打印支持" | 属实：v13.1+ 原生打印（`PrintOptions`: `pageBreak` / `orientation` / `breakInside` 等） | `README.md:306-313`、`dist/types.d.ts` 的 `PrintOptions` |
| "13.3.0 的移动端/打印优化" | 已装 14.1.0 更新，文章提到的能力都包含在内 | npm registry `gridstack/latest` = 14.1.0 |

补充核查（文章未提，但对选型影响更大）：

1. **过时口径：改列数不再需要 `gridstack-extra.css`。** v12+ 改用 CSS 变量（`--gs-columns`），README 明确写
   "step 2 is OLD and not needed with v12+"；本包 `dist/` 里也没有该文件，只有 `gridstack.css` / `gridstack.min.css`。
   注意 `dist/types.d.ts` 里 `Responsive` 的注释仍在提示 "make sure to include ... gridstack-extra.css"，属文档遗留，
   以 `README.md:205-230` 为准。
2. **响应式默认是"同一份布局按新列数重排"，但库内部也缓存各列数的布局。** 切换列数（`grid.column(n)` 或断点触发）时，
   库会保留原来的最大布局并按新列数重排；`save(..., column)` 可导出指定列数的布局，注释明确写着
   "restore to all layouts"（`dist/gridstack.d.ts` 的 `save` 注释；`dist/types.d.ts` 的 `ColumnOptions` 也提到
   "cached layout for that size"）。也就是说：基本响应式**不需要**改 `layout_json`；若产品要求"每端单独手工排一套"，
   库本身能承载（按列 save/load），但多套布局的**持久化**要由应用自己做。README 里的 "per column layouts TBD"
   （`README.md:480`）指的是 1 列模式下的 DOM 排序（`oneColumnModeDomSort` 已移除），不是几何布局。
3. **`react-grid-layout` 也不是"停止维护"的库，且 1.5.4 就自带 `Responsive`。** 项目现用 1.5.4（npm 最新 2.3.0，仍在发版），
   其入口 `index.js` 已导出 `Responsive`（`ResponsiveReactGridLayout`）；本项目只用了固定 `GridLayout`，没用它而已。
   所以"补响应式"不需要换库，甚至不需要升级。
4. **React 19 兼容性无官方声明。** 官方 React wrapper 用 portal + context 渲染，`gridstack@14.1.0` 的 README
   没有给出 React 版本支持矩阵；本项目在 React 19 + Vite 6 下使用前必须实测（见 5.4 风险）。

---

## 3. 项目现状盘点

### 3.1 编辑器链路（`/board/page/:ref` 与 `/board/dash/:id`）

- [frontend/src/pages/board.tsx](../frontend/src/pages/board.tsx) 负责编辑：当前使用 `react-grid-layout@1.5.4` + `WidthProvider`。
- 栅格参数与旧版对齐：**12 列、行高 64px、间距 12px、`compactType={null}`（自由摆放）、`preventCollision`**，拖拽手柄 `.dg-drag`、
  取消区 `.no-drag`，见 [board.tsx:317-333](../frontend/src/pages/board.tsx#L317-L333)。
- 编辑体验已具备：撤销/重做（历史栈 + Ctrl+Z/Y，[board.tsx:104-151](../frontend/src/pages/board.tsx#L104-L151)）、
  "整理布局"（first-fit 压实，[board.tsx:153-181](../frontend/src/pages/board.tsx#L153-L181)）、
  添加组件模板、复制、删除、设置（配置向导）、保存、发布、恢复默认（[board.tsx:241-280](../frontend/src/pages/board.tsx#L241-L280)）。

### 3.2 只读与大屏链路

- 只读渲染不走拖拽库：`WidgetGrid` 用绝对定位 + `calc()` 复刻旧版几何（12 列 × 64px 行高 × 12px 间距），
  见 [frontend/src/features/dashboard.tsx:373-463](../frontend/src/features/dashboard.tsx#L373-L463)。目的：保证历史 `layout_json` 与旧版逐像素一致。
- 大屏 `/screen` 复用同一份布局数据，按行自动分页（[frontend/src/pages/screen.tsx:60-92](../frontend/src/pages/screen.tsx#L60-L92)），
  并按可视高度动态放行高（[screen.tsx:162-167](../frontend/src/pages/screen.tsx#L162-L167)）。
- 结论：**编辑器链路由拖拽库决定，只读/大屏链路只认 `{x,y,w,h}` 几何**。换库主要影响前者，但必须与后者的像素结果保持一致。

### 3.3 数据与接口

- 布局数据结构：`Layout = { widgets: LayoutWidget[] }`，每个 widget 含
  `id / type / title / spec / text / x / y / w / h`，见 [dashboard.tsx:9-23](../frontend/src/features/dashboard.tsx#L9-L23)。
- 持久化：统一存 `dashboards.layout_json`（含按 `page_key` 保存的导航页个人布局与公共默认布局），
  接口见 [api/routes.py:48-56](../api/routes.py#L48-L56)、[:75](../api/routes.py#L75)：
  `PUT /api/pages/:key`（`target=personal|public`）、`PUT /api/dashboards/:id`、`POST .../publish`、`POST .../reset`。
  读写逻辑集中在 [api/dashboard_mixin.py](../api/dashboard_mixin.py) 与 [api/boards_init.py](../api/boards_init.py)。
- 版本语义：导航页看板有"个人版本 / 公共版本"，专题看板有 `version`；发布 ≠ 覆盖别人的个人布局。

### 3.4 现有能力与缺口

| 能力 | 现状 | 说明 |
|---|---|---|
| 拖拽 / 缩放 / 自由摆放 | ✅ 已有 | `compactType={null}` + `preventCollision`，与旧版一致 |
| 撤销 / 重做 / 整理 | ✅ 已有 | 自有历史栈，不依赖拖拽库 |
| 布局保存 / 发布 / 恢复默认 | ✅ 已有 | 走后端 `layout_json` + 版本号 |
| 响应式断点（平板/手机列数变化） | ❌ 缺 | 固定 12 列；`app.css` 只有 7 个媒体查询做页面级适配（`styles/app.css:279/282/297/395/398/445`），不改变看板栅格 |
| 移动端拖拽编辑 | ❌ 缺 | 编辑器按桌面设计；无触摸拖拽验证 |
| Nested Grid / 跨 Grid 拖拽 | ❌ 缺 | 当前无此需求 |
| 打印排版 | ⚠️ 只有页面级 | `@media print` 只隐藏工具栏/侧栏（`styles/app.css:308`），没有组件级分页/横竖版控制 |
| 前端自动化测试 | ❌ 缺 | 编辑器交互仍靠人工走查，P4 中"拖拽/缩放/发布/复制/恢复默认"尚未实测（[P4-剩余事项清单.md:75-83](../P4-剩余事项清单.md#L75-L83)） |

---

## 4. 能力对比：GridStack 14.1.0 vs 现有 react-grid-layout 1.5.4

| 维度 | GridStack 14.1.0 | 现有 react-grid-layout 1.5.4 | 对本项目的影响 |
|---|---|---|---|
| 数据模型 | `{ id, x, y, w, h, ... }`，12 列栅格 | `{ i, x, y, w, h }`，12 列栅格 | 与 `layout_json` 的 `{id,x,y,w,h}` **1:1 兼容**，迁移时几何字段可平移 |
| 拖拽 / 缩放 | 内置（含触摸、`draggable.handle/cancel`） | 内置（鼠标/触摸由 react-draggable 提供） | 现有功能已够用 |
| 自由摆放（不压实） | `mode: 'float'` | `compactType={null}` | 语义可对齐；注意 **v14 把 `float` 选项改名为 `mode`**（旧值运行时兼容，TS 类型已移除，见 `README.md:550-561`） |
| 保存 / 恢复 | `save()` / `load()`，支持嵌套网格 | 组件受控（`layout` + `onLayoutChange`），本项目自己维护状态 | 现有自有状态机更贴合撤销/重做，换库需要重写事件桥接 |
| 响应式断点 | ✅ `columnOpts.breakpoints`，按断点自动重排 | ✅ `Responsive`（按断点切换 `layouts`） | 两库都有；本项目**连 1.5.4 自带的 `Responsive` 都没用上**（只用固定 `GridLayout`），缺的是接入而不是能力 |
| 每端独立布局 | ⚠️ 库内按列缓存、`save(..., column)` 可导出；持久化需应用自建 map | ✅ `Responsive` 的 `layouts` 本身就是按断点一套；持久化需应用自建 map | 想做"手机单独排一套"，两库都要扩展 `layout_json` 存储，成本相当 |
| Nested / 跨 Grid | ✅ `subGridOpts` / `acceptWidgets` | ❌ 需自己组合多个 Grid | 当前无需求；将来做"页面搭建器"才有价值 |
| 打印 | ✅ `PrintOptions`（分页、横竖版、保持整块） | ❌ 只有 CSS `@media print` | 将来"大屏/看板正式打印"才有价值 |
| React 集成 | 官方 wrapper `gridstack/dist/react`（portal 渲染、`useGridStack`、`useWidgetSerializer`） | 原生 React 组件，props 即状态 | GridStack 的 wrapper 是"命令式库 + portal"，与 React 状态模型耦合更松，但需要额外适配 |
| 依赖 / 体积 | 零运行时依赖；`dist/gridstack-all.js` ≈ 95KB（min，未 gzip）+ CSS ≈ 6KB | 依赖 react-draggable / react-resizable 等 | 当前打包单 chunk 1.08MB(gzip 348KB)（[P4-剩余事项清单.md:119](../P4-剩余事项清单.md#L119)），新增库影响有限，需实测 |
| 维护状态 | 活跃（14.1.0 = npm 最新） | 活跃（2.3.0 = npm 最新，项目落后一个大版本） | 两者都不是"停止维护"，不能用"换活跃库"当理由 |
| 迁移成本 | 编辑器需重写事件桥接 + 样式 + 只读一致性验证 | 0（不动） | 见第 5 节 |

---

## 5. 若未来迁移：改造点、成本与风险（只评估，不实施）

### 5.1 编辑器改造（`board.tsx`）

1. 引入 `gridstack/dist/gridstack.css`（可与 `react-grid-layout` 的 CSS 冲突，若迁移需移除 rgl 样式）。
2. 初始化参数需对齐现有视觉（注意 v14 的 `float` 已改名为 `mode`，见 `README.md:550-561`）：
   ```ts
   const options = {
     column: 12,
     cellHeight: 64,
     margin: 12,
     mode: "float",                                 // 对齐 compactType=null（v14 前写作 float: true）
     draggable: { handle: ".dg-drag", cancel: ".no-drag" },
   };
   ```
3. 数据映射：`layout.widgets` → `children`，用 wrapper 的 `component` + `props` 承载 `type/title/spec/text`；
   保存时用 `grid.save()` + `useWidgetSerializer` 把这几个自定义字段合并回 `props`，再转回现有 `widgets[]` 结构。
4. 事件桥接：拖拽/缩放开始/结束（`dragstart/dragstop/resizestop/change`）替换现有 `rememberDrag / finishDrag / applyLayout`，
   继续维护 `past/future` 历史栈；撤销/重做改为 `grid.load()` 恢复。
5. 拖拽手柄在 widget 内容（面板标题 `.dg-drag`）里时：用 wrapper 的 `<GridStackItem>` 会**自动**在每次 portal 渲染后调用
   `grid.refreshDragHandles()`（`dist/react/gridstack-item.js:93`），无需手动处理；只有绕过 wrapper 直接用 `grid` API
   管理 item 元素时，才需要自己调用 `grid.refreshDragHandles(itemEl)`（`dist/gridstack.d.ts:806`）。

### 5.2 数据与存储

- 基本响应式**不需要**改 `layout_json`：`save()` 默认返回"最大布局"，各断点由库重排/内部按列缓存。
- 若产品要求"手机端单独手工排版"，才需要把 `layout_json` 从 `widgets[]` 扩展为按列数分组的结构（这一点两家库一样），
  并同步改个人/公共版本与发布语义——**这是真正的隐性成本**，也是要提前定死的数据模型决策。
- 现有后端接口（`/api/pages/:key`、`/api/dashboards/:id`、publish/reset）可保持不变，前提是前端仍提交 `{widgets:[...]}`。

### 5.3 只读链路

- `WidgetGrid`（绝对定位 calc）与大屏分页**不建议迁移**：它们与拖拽库无关，且是旧版几何一致性的保证。
- 前提是编辑器布局与只读渲染像素一致；当前 12 列 / 64px / 12px 的换算已在两处对齐，校验成本可控。

### 5.4 风险清单

| 风险 | 说明 | 缓解 |
|---|---|---|
| React 19 兼容 | wrapper 用 portal + context 渲染，仓库内没有 React 19 用例；需在 React 19 + Vite 6 下实测 | 先做单页 PoC 并 `npm run build` |
| 历史栈语义 | 现有撤销/重做基于受控 `layout` 数组，换库后要靠事件重建 | PoC 阶段先做 drag/resize/undo 三件事 |
| 只读一致性 | 编辑器所见与 `WidgetGrid`/大屏渲染不一致会直接暴露 | 提供几何对比用例（同一 `layout_json` 截图比对） |
| 回归面 | 保存/发布/恢复默认/大屏分页/打印，且 P4 编辑器验收尚未完成 | 先完成现有编辑器验收，再考虑换库 |
| 无前端自动化测试 | 换库无回归网，只能人工走查 | 换库前补最小交互冒烟（或先只做只读侧 PoC） |

---

## 6. 结论与决策触发条件

### 6.1 为什么现在不迁移

1. **现有实现已覆盖核心需求**：拖拽、缩放、自由摆放、撤销/重做、整理、保存、发布、恢复默认都在生产代码里，
   且与旧版几何逐像素对齐；换库没有用户可感知的收益。
2. **GridStack 的增量能力当前没有业务落点**：本项目是局域网桌面看板 + 大屏（[README.md:94-97](../README.md#L94-L97)，
   大屏分辨率适配见 [:521](../README.md#L521)），
   移动端编辑、嵌套画布、跨 Grid 拖拽、打印排版都不在现有需求清单里。
3. **成本在数据与验收，不在 UI**：换库要重写事件桥接、处理 React 19 + portal + ECharts 性能、保证只读一致，
   而现有编辑器验收（P4 B-7）还没做完，先换库会叠加风险。

### 6.2 什么时候重新评估（满足任一即可）

- 需要**移动端查看/编辑**（平板、手机列数自适应）→ 响应式断点成为刚需；
- 需要**大屏/看板正式打印**（分页、横竖版、组件不切半）→ `PrintOptions` 有直接价值；
- 需要**嵌套看板 / 跨大屏拖拽 / 页面搭建器**（低代码方向）；
- `react-grid-layout` 1.x 遇到无法绕过的缺陷，或团队决定统一升级到 2.x 后发现仍不满足。

### 6.3 低成本替代路径（优先级高于换库）

1. **只补响应式**：项目已装的 `react-grid-layout@1.5.4` 入口 `index.js` 就导出了 `Responsive`（`ResponsiveReactGridLayout`），
   把它接到 `board.tsx` 替换固定 `GridLayout` 即可，不必升级到 2.x、更不必换库；升级 2.3.0 只是顺带保持维护更新。
2. **只补打印**：先不做库迁移，评估用 GridStack 仅在"打印/导出"场景做只读渲染 PoC（单独页面），验证效果后再决定是否替换编辑器。
3. **只读侧先试**：用 GridStack 静态渲染一份 `layout_json` 与现有 `WidgetGrid` 做像素对比，成本最低、风险最小。

### 6.4 依赖处置建议

- `frontend/package.json:15` 已加入 `gridstack ^14.1.0`，但代码中尚无任何引用（`node_modules` 已安装）。
- 本次**不改** `package.json`：保留该依赖用于后续 PoC 是合理的；若确定不打算用，再单独清理，避免"装了但没人知道为什么装"。
- 无论是否迁移，**不要同时**引入 `gridstack.css` 与 `react-grid-layout` 的样式，二者都会改 `.grid-stack`/栅格类，容易互相踩。

---

## 7. 参考资料

- 原文：https://mp.weixin.qq.com/s/jIfKmTLSESgqMBsM2jGHYQ
- GridStack 官网：https://gridstackjs.com/
- GridStack 源码：https://github.com/gridstack/gridstack.js
- 本地包内文档（最贴近 14.1.0 事实）：
  - `frontend/node_modules/gridstack/README.md`（列数/响应式/打印/版本迁移）
  - `frontend/node_modules/gridstack/react/README.md`（React wrapper 用法、save/restore、自定义拖拽手柄）
  - `frontend/node_modules/gridstack/dist/types.d.ts`（`Responsive` / `Breakpoint` / `PrintOptions`）
  - `frontend/node_modules/gridstack/dist/gridstack.d.ts`（`save()` / `load()` / 事件 API）
- npm registry：`gridstack` 最新 14.1.0；`react-grid-layout` 最新 2.3.0
- 项目内相关实现：`frontend/src/pages/board.tsx`、`frontend/src/features/dashboard.tsx`、`frontend/src/pages/screen.tsx`、
  `api/routes.py`、`api/dashboard_mixin.py`、`P4-剩余事项清单.md`

## 附录 A：文章原文要点摘要（中文）

> 做后台管理系统、数据大屏或 SaaS 平台时，"让用户自己拖动、调整和排列页面上的组件"看起来简单，真正开发起来却挺麻烦：
> 拖拽、碰撞、缩放、响应式、布局保存一堆细节。GridStack.js 是一个 TypeScript 网格布局库，可以直接做出可拖拽、可缩放、
> 响应式的 Dashboard；最基础的代码只有几行（`GridStack.init()` + `grid.load([...])`），就能得到"拖动 + 缩放 + 自动排列"。
> 它特别适合 Dashboard：用户拖动模块重排布局，布局可保存，下次打开保持位置。还支持跨 Grid 拖拽（组件从一个 Grid 拖到另一个）、
> Nested Grids（Grid 里再放 Grid），适合复杂 Dashboard、页面搭建器、低代码平台；响应式可按屏幕尺寸调整列数（桌面 12 列、
> 平板 8 列、手机 1~2 列），支持移动端触摸；官方提供 Angular / React / Vue wrapper。它真正有意思的地方不是"拖拽"，
> 而是让用户自己决定页面怎么布局：添加组件 → 拖动位置 → 调整大小 → 删除组件 → 保存布局，最终每个人都可以拥有自己的
> Dashboard，从"固定页面"变成"可配置页面"。安装简单（`npm install gridstack`，引入 CSS 后 `GridStack.init()`）。
> 13.3.0 还优化了移动端拖动/滚动行为与打印能力；它已不只是拖拽组件，而是比较完整的 Dashboard Layout Engine。
> 如果只是简单拖拽卡片，自己写可能不难；但需求叠加成"拖拽 + 缩放 + 响应式 + 布局保存 + 跨 Grid + Nested Grid + 移动端"，
> 事情就复杂了，这时 GridStack.js 的价值就出来了。
