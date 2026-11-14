import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { api } from "../lib/api";
import { money, num, pct } from "../lib/format";
import { BarChart, DonutChart, FunnelChart, LineChart } from "../components/charts";
import { Empty, Loading } from "../components/ui";

export interface LayoutWidget {
  id: string;
  type: "kpi" | "bar" | "line" | "pie" | "funnel" | "table" | "detail" | "alert" | "progress" | "text";
  title: string;
  spec?: Record<string, unknown>;
  text?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  widgets: LayoutWidget[];
}

type WidgetSeries = {
  name: string;
  values: number[];
  metric?: string;
};

interface WidgetColumn {
  key: string;
  label: string;
  align?: string;
}

export type WidgetData =
  | { kind: "value"; value: number | string; metric: string; label: string; unit?: string; delta?: number | null; prev_value?: number | string; prev_date?: string }
  | { kind: "series"; categories: string[]; series: WidgetSeries[]; dimension?: string }
  | { kind: "funnel"; items: { label: string; value: number }[] }
  | { kind: "rows"; rows: Record<string, unknown>[]; columns: WidgetColumn[]; total?: number; empty_text?: string }
  | { kind: "text"; text: string };

/** 与旧版 web/grid.js 的 DEFAULTS 保持一致：行高 64px、间距 12px、12 列。 */
const ROW_HEIGHT = 64;
const ROW_GAP = 12;
const COLS = 12;

/** 组件级配色：默认单色，马卡龙/多巴胺为可选色系（与旧版 COLOR_SCHEMES 一致）。 */
const COLOR_SCHEMES: Record<string, string[]> = {
  "": ["#1d5fbf"],
  macaron: ["#b25c7a", "#4a7ba7", "#4f8f6a", "#b3832e", "#7c67a8", "#3f8e93"],
  dopamine: ["#ff5d8f", "#ff9f1c", "#e0b100", "#2ec4b6", "#3a86ff", "#8e44ad"],
};

export function paletteFor(spec?: Record<string, unknown>): string[] | null {
  if (!spec) return null;
  const scheme = spec.color_scheme as string | undefined;
  const single = spec.color as string | undefined;
  if (!scheme && !single) return null;
  const colors = COLOR_SCHEMES[scheme || ""] || null;
  if (single) {
    return colors ? [single, ...colors.filter((c) => c !== single)] : [single];
  }
  return colors;
}

/** 人效类指标：值是「行/小时」，按 1 位小数展示，不能套百分比。与旧版 web/app.js:2806-2826 一致。 */
const PER_HOUR_METRICS = new Set(["pick_rate", "check_rate", "labor_rate"]);

/** 工时类指标：1 位小数 + h。 */
const HOURS_METRICS = new Set([
  "labor_hours",
  "pick_hours",
  "check_hours",
  "cycle_avg",
  "cycle_max",
  "pick_lag_avg",
  "check_lag_avg",
  "out_lag_avg",
]);

/** KPI 取值与单位，逐条对齐旧版 web/app.js:2806-2826 的 drawData 分支。 */
function formatKpi(metric: string, value: number | string | null | undefined, unit?: string) {
  const metricUnit = unit || "";
  const isAmount = metric === "amount" || /_amount$/.test(metric);
  if (value === null || value === undefined) {
    return { text: "-", unit: isAmount ? metricUnit || "万元" : metricUnit };
  }
  if (typeof value === "string") return { text: value, unit: metricUnit };
  if (PER_HOUR_METRICS.has(metric)) return { text: num(value, 1), unit: metricUnit || "行/小时" };
  if (metric.includes("_rate")) return { text: pct(value), unit: "" };
  if (HOURS_METRICS.has(metric)) return { text: num(value, 1), unit: metricUnit || "h" };
  return { text: num(value, isAmount ? 2 : 0), unit: isAmount ? metricUnit || "万元" : metricUnit };
}

const DIMENSION_LABELS: Record<string, string> = {
  route: "承运商 / 线路",
  zone: "库区",
  region: "区域",
  doc_type: "单据类型",
  dealer: "经销商",
  wave: "波次",
  carrier_tms: "运输承运商",
  status: "发运状态",
  hour: "小时",
  date: "日期",
  erp_status: "ERP回传状态",
  person: "人员",
  pick_person: "拣货人",
  check_person: "复核人",
  warehouse: "仓库",
  freight_free: "是否免运费",
};

function dimensionLabel(dimension?: string) {
  return (dimension && DIMENSION_LABELS[dimension]) || "维度";
}

/** 表格单元格：与旧版 web/app.js:2636-2648 seriesToTable 的取值规则一致。 */
function tableCell(metric: string, value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  if (PER_HOUR_METRICS.has(metric)) return num(value, 1);
  if (metric.includes("_rate")) return pct(value);
  return num(value, metric === "amount" || /_amount$/.test(metric) ? 2 : 0);
}

/** table / detail 组件：后端返回的是 series，需在前端转成表格（旧版 seriesToTable 同构）。 */
function TableBody({ data }: { data: Extract<WidgetData, { kind: "series" }> }) {
  if (!data.categories.length) return <Empty text="暂无数据" />;
  return (
    <div className="table-wrap" style={{ maxHeight: "100%" }}>
      <table className="tbl">
        <thead>
          <tr>
            <th>{dimensionLabel(data.dimension)}</th>
            {data.series.map((series) => (
              <th key={series.metric || series.name} className="num">
                {series.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.categories.map((label, index) => (
            <tr key={`${label}-${index}`}>
              <td className="nowrap">{label}</td>
              {data.series.map((series) => (
                <td key={series.metric || series.name} className="num">
                  {tableCell(series.metric || "", series.values[index])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SeriesBody({
  data,
  type,
  palette,
  showValues,
  fontSize,
}: {
  data: Extract<WidgetData, { kind: "series" }>;
  type: string;
  palette?: string[] | null;
  showValues?: boolean;
  fontSize?: number;
}) {
  if (type === "pie") {
    const first = data.series[0];
    const rows = data.categories.map((label, index) => ({ label, value: Number(first?.values[index] || 0) }));
    return <DonutChart rows={rows} height="100%" palette={palette || undefined} showValues={showValues} fontSize={fontSize} />;
  }
  if (type === "progress") {
    const rateIndex = data.series.findIndex((item) => item.metric === "out_rate");
    const labelSeries = data.series[0];
    return (
      <div style={{ padding: "4px 2px", height: "100%", overflow: "auto" }}>
        {data.categories.map((label, index) => {
          const rate = rateIndex >= 0 ? Number(data.series[rateIndex]?.values[index] || 0) : 0;
          return (
            <div key={label} style={{ marginBottom: 8 }}>
              <div className="small" style={{ display: "flex", justifyContent: "space-between" }}>
                <span>{label}</span>
                <span className="muted">
                  {pct(rate)} · {num(Number(labelSeries?.values[index] || 0))}
                </span>
              </div>
              <div style={{ height: 6, background: "#eef1f6", borderRadius: 4, marginTop: 3 }}>
                <div
                  style={{
                    width: `${Math.min(100, rate * 100)}%`,
                    height: "100%",
                    borderRadius: 4,
                    background: rate >= 0.999 ? "#0b8a63" : rate >= 0.6 ? "#1d5fbf" : "#b45309",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    );
  }
  if (type === "line") {
    return <LineChart categories={data.categories} series={data.series} height="100%" palette={palette || undefined} showValues={showValues} fontSize={fontSize} />;
  }
  return (
    <BarChart
      categories={data.categories}
      series={data.series}
      height="100%"
      horizontal={data.categories.length > 8}
      palette={palette || undefined}
      showValues={showValues}
      fontSize={fontSize}
    />
  );
}

function RowsBody({ data }: { data: Extract<WidgetData, { kind: "rows" }> }) {
  if (!data.rows.length) return <Empty text={data.empty_text || "暂无数据"} />;
  return (
    <div className="table-wrap" style={{ maxHeight: "100%" }}>
      <table className="tbl">
        <thead>
          <tr>
            {data.columns.map((column) => (
              <th key={column.key} className={column.align === "right" ? "num" : ""}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, index) => (
            <tr key={String(row.group_no ?? row.id ?? index)}>
              {data.columns.map((column) => {
                const value = row[column.key];
                const isRate = column.key.endsWith("_rate");
                const isAmount = column.key === "amount" && typeof value === "number";
                return (
                  <td key={column.key} className={column.align === "right" ? "num" : ""}>
                    {isRate ? pct(value as number) : isAmount ? money(value as number) : (value as string) ?? "-"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WidgetBody({
  type,
  data,
  palette,
  showValues,
  title,
  fontSize,
}: {
  type: LayoutWidget["type"];
  data: WidgetData;
  palette?: string[] | null;
  showValues?: boolean;
  title?: string;
  fontSize?: number;
}) {
  if (data.kind === "text") return <div className="small">{data.text}</div>;
  if (data.kind === "value") {
    const kpi = formatKpi(data.metric, data.value, data.unit);
    const trend = typeof data.delta === "number" && Number.isFinite(data.delta) ? data.delta : null;
    return (
      <>
        <div className="kpi-label">{title || data.label}</div>
        <div className="kpi-value">
          {kpi.text}
          {kpi.unit && <span className="kpi-unit">{kpi.unit}</span>}
        </div>
        <div className="kpi-sub">
          {trend !== null && data.prev_date && (
            <span className={trend >= 0 ? "kpi-up" : "kpi-down"}>
              较 {String(data.prev_date).slice(5)} {trend >= 0 ? "▲" : "▼"} {pct(Math.abs(trend))}
            </span>
          )}
        </div>
      </>
    );
  }
  if (data.kind === "funnel") return <FunnelChart rows={data.items} height="100%" palette={palette || undefined} fontSize={fontSize} />;
  if (data.kind === "rows") return <RowsBody data={data} />;
  if (data.kind === "series") {
    // table/detail 也要画成表格：旧版 web/app.js:2916 对这两种类型走 seriesToTable。
    if (type === "table" || type === "detail") return <TableBody data={data} />;
    return <SeriesBody data={data} type={type} palette={palette} showValues={showValues} fontSize={fontSize} />;
  }
  return null;
}

export function WidgetCard({
  widget,
  date,
  mode = "live",
  actions,
  fontSize,
}: {
  widget: LayoutWidget;
  date: string;
  mode?: "live" | "archive";
  actions?: ReactNode;
  fontSize?: number;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["widget", widget.type, widget.id, date, mode, widget.spec],
    queryFn: () =>
      api<WidgetData>("/api/widget", {
        method: "POST",
        body: { widget_type: widget.type, date, spec: widget.spec, text: widget.text, mode },
      }),
  });
  const palette = paletteFor(widget.spec);
  const showValues = widget.spec?.show_values !== false;
  const isKpi = widget.type === "kpi";

  if (isKpi) {
    return (
      <div className="kpi">
        {actions && (
          <div style={{ position: "absolute", top: 6, right: 8, zIndex: 2, display: "flex", gap: 6 }}>{actions}</div>
        )}
        {isLoading ? (
          <Loading />
        ) : error ? (
          <div className="widget-error">{(error as Error).message}</div>
        ) : data ? (
          <WidgetBody type={widget.type} data={data} palette={palette} showValues={showValues} title={widget.title} fontSize={fontSize} />
        ) : null}
      </div>
    );
  }

  return (
    <section className="panel" style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
      <div className="panel-head" style={{ flex: "0 0 auto" }}>
        <div className="panel-title dg-drag">{widget.title}</div>
        {actions}
      </div>
      <div
        className="panel-body"
        style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}
      >
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {isLoading ? (
            <Loading />
          ) : error ? (
            <div className="widget-error">{(error as Error).message}</div>
          ) : data ? (
            <WidgetBody type={widget.type} data={data} palette={palette} showValues={showValues} title={widget.title} fontSize={fontSize} />
          ) : null}
        </div>
      </div>
    </section>
  );
}

/**
 * 只读布局：与旧版 web/grid.js 的几何算法逐像素一致（12 列、行高 rowHeight、间距 ROW_GAP）。
 * 旧版：cellW=(W-gap*(cols+1))/cols，left=gap+x*(cellW+gap)，width=w*cellW+(w-1)*gap，
 * top=gap+y*(rowHeight+gap)，height=h*rowHeight+(h-1)*gap，容器高=rows*(rowHeight+gap)+gap。
 * 用 calc() 复刻同一公式，保证历史 layout_json 的组件位置/尺寸与旧版一致。
 */
export function WidgetGrid({
  layout,
  date,
  mode = "live",
  rowHeight = ROW_HEIGHT,
  kpiBand = true,
  fontSize,
}: {
  layout: Layout;
  date: string;
  mode?: "live" | "archive";
  rowHeight?: number;
  /** KPI 单独排成 6 列 88px 数字带（与样卡 .kpis 一致）；看板编辑器/大屏用原栅格。 */
  kpiBand?: boolean;
  /** 图表内文字字号（ECharts 画布渲染，需显式传入才能放大）。 */
  fontSize?: number;
}) {
  const widgets = layout.widgets || [];
  if (!widgets.length) return <Empty text="这个页面还没有组件" />;

  // 旧版 cellW=(W-gap*(cols+1))/cols；用 (100% - 156px) 表示总列宽，再按 x/12、w/12 折算。
  const span = (n: number) => (n / COLS).toFixed(6);
  const gutter = ROW_GAP * (COLS + 1);

  if (!kpiBand) {
    const rows = Math.max(...widgets.map((item) => item.y + item.h), 1);
    return (
      <div style={{ position: "relative", height: rows * (rowHeight + ROW_GAP) + ROW_GAP }}>
        {widgets.map((widget) => (
          <div
            key={widget.id}
            style={{
              position: "absolute",
              left: `calc((100% - ${gutter}px) * ${span(widget.x)} + ${ROW_GAP + widget.x * ROW_GAP}px)`,
              top: ROW_GAP + widget.y * (rowHeight + ROW_GAP),
              width: `calc((100% - ${gutter}px) * ${span(widget.w)} + ${(widget.w - 1) * ROW_GAP}px)`,
              height: widget.h * rowHeight + (widget.h - 1) * ROW_GAP,
            }}
          >
            <WidgetCard widget={widget} date={date} mode={mode} fontSize={fontSize} />
          </div>
        ))}
      </div>
    );
  }

  // KPI 让出的行数从下方组件的 y 里减掉，整体上移，避免留白。
  const kpis = widgets.filter((item) => item.type === "kpi").sort((a, b) => a.y - b.y || a.x - b.x);
  const panels = widgets.filter((item) => item.type !== "kpi");
  const kpiRows = kpis.length ? Math.max(...kpis.map((item) => item.y + item.h)) : 0;
  const rows = panels.length ? Math.max(...panels.map((item) => Math.max(0, item.y - kpiRows) + item.h), 1) : 0;

  return (
    <>
      {kpis.length > 0 && (
        <div className="kpis" style={{ marginBottom: panels.length ? 12 : 0 }}>
          {kpis.map((widget) => (
            <WidgetCard key={widget.id} widget={widget} date={date} mode={mode} fontSize={fontSize} />
          ))}
        </div>
      )}
      {panels.length > 0 && (
        <div style={{ position: "relative", height: rows * (rowHeight + ROW_GAP) + ROW_GAP }}>
          {panels.map((widget) => {
            const y = Math.max(0, widget.y - kpiRows);
            return (
              <div
                key={widget.id}
                style={{
                  position: "absolute",
                  left: `calc((100% - ${gutter}px) * ${span(widget.x)} + ${ROW_GAP + widget.x * ROW_GAP}px)`,
                  top: ROW_GAP + y * (rowHeight + ROW_GAP),
                  width: `calc((100% - ${gutter}px) * ${span(widget.w)} + ${(widget.w - 1) * ROW_GAP}px)`,
                  height: widget.h * rowHeight + (widget.h - 1) * ROW_GAP,
                }}
              >
                <WidgetCard widget={widget} date={date} mode={mode} fontSize={fontSize} />
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

export function usePageLayout(pageKey: string) {
  return useQuery({
    queryKey: ["page", pageKey],
    queryFn: () =>
      api<{
        key: string;
        name: string;
        layout: Layout;
        source: string;
        can_edit: boolean;
        can_publish: boolean;
        public_version: number;
        personal_version: number;
      }>(`/api/pages/${pageKey}`),
  });
}
