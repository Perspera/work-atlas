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

interface WidgetSeries {
  name: string;
  values: number[];
  metric?: string;
}

interface WidgetColumn {
  key: string;
  label: string;
  align?: string;
}

type WidgetData =
  | { kind: "value"; value: number | string; metric: string; label: string; unit?: string; delta?: number | null; prev_value?: number | string; prev_date?: string }
  | { kind: "series"; categories: string[]; series: WidgetSeries[]; dimension?: string }
  | { kind: "funnel"; items: { label: string; value: number }[] }
  | { kind: "rows"; rows: Record<string, unknown>[]; columns: WidgetColumn[]; total?: number; empty_text?: string }
  | { kind: "text"; text: string };

const ROW_HEIGHT = 60;

function formatMetric(metric: string, value: number | string | null | undefined) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  if (metric.endsWith("_rate")) return pct(value);
  if (metric === "amount" || metric.endsWith("_amount")) return money(value);
  return num(value, Number.isInteger(value) ? 0 : 2);
}

function SeriesBody({ data, type }: { data: Extract<WidgetData, { kind: "series" }>; type: string }) {
  if (type === "pie") {
    const first = data.series[0];
    const rows = data.categories.map((label, index) => ({ label, value: Number(first?.values[index] || 0) }));
    return <DonutChart rows={rows} height="100%" />;
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
    return <LineChart categories={data.categories} series={data.series} height="100%" />;
  }
  return <BarChart categories={data.categories} series={data.series} height="100%" />;
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

export function WidgetBody({ type, data }: { type: LayoutWidget["type"]; data: WidgetData }) {
  if (data.kind === "text") return <div className="small">{data.text}</div>;
  if (data.kind === "value") {
    return (
      <div style={{ display: "flex", alignItems: "center", height: "100%" }}>
        <div>
          <div className="kpi-value" style={{ marginTop: 0 }}>
            {formatMetric(data.metric, data.value)}
            {data.unit && <span className="kpi-unit">{data.unit}</span>}
          </div>
          {typeof data.delta === "number" && (
            <div className={`kpi-sub ${data.delta >= 0 ? "kpi-up" : "kpi-down"}`}>
              环比 {data.delta >= 0 ? "+" : ""}
              {pct(data.delta)}（{data.prev_date}）
            </div>
          )}
        </div>
      </div>
    );
  }
  if (data.kind === "funnel") return <FunnelChart rows={data.items} height="100%" />;
  if (data.kind === "rows") return <RowsBody data={data} />;
  if (data.kind === "series") return <SeriesBody data={data} type={type} />;
  return null;
}

export function WidgetCard({
  widget,
  date,
  mode = "live",
  actions,
}: {
  widget: LayoutWidget;
  date: string;
  mode?: "live" | "archive";
  actions?: ReactNode;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["widget", widget.type, widget.id, date, mode, widget.spec],
    queryFn: () =>
      api<WidgetData>("/api/widget", {
        method: "POST",
        body: { widget_type: widget.type, date, spec: widget.spec, text: widget.text, mode },
      }),
  });

  return (
    <section className="panel" style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
      {widget.type !== "kpi" && (
        <div className="panel-head" style={{ flex: "0 0 auto" }}>
          <div className="panel-title dg-drag">{widget.title}</div>
          {actions}
        </div>
      )}
      {widget.type === "kpi" && actions && (
        <div style={{ position: "absolute", right: 4, top: 4, zIndex: 2 }}>{actions}</div>
      )}
      <div
        className="panel-body"
        style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}
      >
        {widget.type === "kpi" && <div className="kpi-label">{widget.title}</div>}
        <div style={{ flex: 1, minHeight: 0 }}>
          {isLoading ? <Loading /> : error ? <div className="widget-error">{(error as Error).message}</div> : data ? <WidgetBody type={widget.type} data={data} /> : null}
        </div>
      </div>
    </section>
  );
}

/** 只读布局：沿用旧版 12 列 × 60px 行的 layout 结构，保证历史布局位置一致。 */
export function WidgetGrid({
  layout,
  date,
  mode = "live",
  rowHeight = ROW_HEIGHT,
}: {
  layout: Layout;
  date: string;
  mode?: "live" | "archive";
  rowHeight?: number;
}) {
  const widgets = layout.widgets || [];
  if (!widgets.length) return <Empty text="这个页面还没有组件" />;
  const rows = Math.max(...widgets.map((item) => item.y + item.h), 1);
  return (
    <div style={{ position: "relative", height: rows * rowHeight }}>
      {widgets.map((widget) => (
        <div
          key={widget.id}
          style={{
            position: "absolute",
            left: `${(widget.x / 12) * 100}%`,
            top: widget.y * rowHeight,
            width: `${(widget.w / 12) * 100}%`,
            height: widget.h * rowHeight,
            padding: 6,
          }}
        >
          <WidgetCard widget={widget} date={date} mode={mode} />
        </div>
      ))}
    </div>
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
