import ReactEChartsCore from "echarts-for-react/lib/core";
import * as echarts from "echarts/core";
import { BarChart as EBar, FunnelChart as EFunnel, LineChart as ELine, PieChart as EPie } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { ReactNode } from "react";

import { num, pct } from "../lib/format";
import type { Series } from "../lib/types";

// 只注册用到的图表与组件，避免整包 echarts 进首屏
echarts.use([EBar, ELine, EPie, EFunnel, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

const PALETTE = ["#1d5fbf", "#0f766e", "#b45309", "#7c3aed", "#be123c", "#0e7490"];

function baseOption(categories: string[], series: Series[], horizontal?: boolean) {
  return {
    color: PALETTE,
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: { right: 8, top: 0, type: "scroll", textStyle: { color: "#5b6472" } },
    grid: { left: 12, right: 16, top: 34, bottom: 8, containLabel: true },
    xAxis: horizontal
      ? { type: "value" }
      : {
          type: "category",
          data: categories,
          axisLabel: { color: "#5b6472", interval: 0, rotate: categories.length > 10 ? 30 : 0 },
          axisTick: { show: false },
        },
    yAxis: horizontal
      ? {
          type: "category",
          data: categories,
          axisLabel: { color: "#5b6472" },
          axisTick: { show: false },
        }
      : { type: "value", axisLabel: { color: "#5b6472" }, splitLine: { lineStyle: { color: "#eef1f6" } } },
    series: series.map((item) => ({
      name: item.name,
      type: horizontal ? "bar" : "bar",
      data: item.values,
      barMaxWidth: 26,
      emphasis: { focus: "series" },
    })),
  };
}

export function BarChart({
  categories,
  series,
  height = 240,
  horizontal,
}: {
  categories: string[];
  series: Series[];
  height?: number | string;
  horizontal?: boolean;
}) {
  if (!categories.length) return <div className="empty">暂无数据</div>;
  return (
    <ReactEChartsCore
      echarts={echarts}
      notMerge
      style={{ height }}
      option={baseOption(categories, series, horizontal)}
    />
  );
}

export function LineChart({
  categories,
  series,
  height = 240,
}: {
  categories: string[];
  series: Series[];
  height?: number | string;
}) {
  if (!categories.length) return <div className="empty">暂无数据</div>;
  const option = baseOption(categories, series);
  const lineOption = {
    ...option,
    series: series.map((item) => ({
      name: item.name,
      type: "line",
      data: item.values,
      smooth: true,
      symbolSize: 6,
      areaStyle: { opacity: 0.08 },
    })),
  };
  return <ReactEChartsCore echarts={echarts} notMerge style={{ height }} option={lineOption} />;
}

export function DonutChart({
  rows,
  height = 240,
}: {
  rows: { label: string; value: number }[];
  height?: number | string;
}) {
  if (!rows.length) return <div className="empty">暂无数据</div>;
  return (
    <ReactEChartsCore
      echarts={echarts}
      notMerge
      style={{ height }}
      option={{
        color: PALETTE,
        tooltip: { trigger: "item", formatter: "{b}: {c}（{d}%）" },
        legend: { orient: "vertical", right: 6, top: "middle", type: "scroll" },
        series: [
          {
            type: "pie",
            radius: ["46%", "70%"],
            center: ["38%", "52%"],
            avoidLabelOverlap: true,
            label: { show: false },
            data: rows.map((row) => ({ name: row.label, value: row.value })),
          },
        ],
      }}
    />
  );
}

export function FunnelChart({
  rows,
  height = 260,
}: {
  rows: { label: string; value: number }[];
  height?: number | string;
}) {
  if (!rows.length) return <div className="empty">暂无数据</div>;
  return (
    <ReactEChartsCore
      echarts={echarts}
      notMerge
      style={{ height }}
      option={{
        color: PALETTE,
        tooltip: { trigger: "item", formatter: "{b}: {c}" },
        series: [
          {
            type: "funnel",
            left: "8%",
            right: "8%",
            top: 12,
            bottom: 12,
            minSize: "26%",
            label: { show: true, position: "inside", formatter: "{b} {c}" },
            data: rows.map((row) => ({ name: row.label, value: row.value })),
          },
        ],
      }}
    />
  );
}

export function KpiCard({
  label,
  value,
  unit,
  sub,
  tone,
  children,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  tone?: "up" | "down";
  children?: ReactNode;
}) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">
        {value}
        {unit && <span className="kpi-unit">{unit}</span>}
      </div>
      {sub !== undefined && (
        <div className={`kpi-sub${tone ? ` kpi-${tone}` : ""}`}>{sub}</div>
      )}
      {children}
    </div>
  );
}

/** KPI 环比：正增长在单量场景用暖色，回落用绿色。 */
export function deltaText(current: number | undefined, prev: number | undefined) {
  if (current === undefined || prev === undefined || !prev) return "-";
  const diff = current - prev;
  return `${diff >= 0 ? "+" : ""}${num(diff)}（${diff >= 0 ? "+" : ""}${pct(diff / prev)}）`;
}
