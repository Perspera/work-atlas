import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { num, pct } from "../lib/format";
import { useBizDate } from "../lib/hooks";
import type { VolumeBreakdown, VolumePeriodData } from "../lib/types";
import { Loading, PageHead, Panel } from "../components/ui";

const PERIODS = [
  { key: "today", label: "今日" },
  { key: "week", label: "本周" },
  { key: "month", label: "本月" },
  { key: "quarter", label: "本季度" },
];

function changeText(current: number, before: number) {
  if (!before) return "-";
  const delta = current - before;
  return `${delta >= 0 ? "+" : ""}${num(delta)}（${delta >= 0 ? "+" : ""}${pct(delta / before)}）`;
}

function changeClass(current: number, before: number) {
  if (!before) return "";
  return current - before >= 0 ? "up" : "down";
}

function BreakdownTable({ rows }: { rows: VolumeBreakdown[] }) {
  return (
    <div className="table-wrap" style={{ maxHeight: 310 }}>
      <table className="tbl">
        <thead>
          <tr>
            <th>维度</th>
            <th className="num">本期行数</th>
            <th className="num">本期金额(万)</th>
            <th className="num">环比</th>
            <th className="num">同比</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">暂无数据</td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td className="num">{num(row.lines)}</td>
              <td className="num">{row.amount === null ? "-" : num(row.amount, 2)}</td>
              <td className={`num ${changeClass(row.lines, row.prev_lines)}`}>
                {changeText(row.lines, row.prev_lines)}
              </td>
              <td className={`num ${changeClass(row.lines, row.yoy_lines)}`}>
                {changeText(row.lines, row.yoy_lines)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompareCard({
  label,
  value,
  unit,
  prev,
  yoy,
  digits,
}: {
  label: string;
  value: number | null;
  unit: string;
  prev?: number | null;
  yoy?: number | null;
  digits?: number;
}) {
  const show = (target?: number | null) =>
    target === null || target === undefined ? "-" : num(target, digits || 0);
  return (
    <div className="panel">
      <div className="panel-body">
        <div className="kpi-label">{label}</div>
        <div className="kpi-value">
          {show(value)}
          <span className="kpi-unit">{unit}</span>
        </div>
        <div className="kpi-sub">环比 {show(prev)} · 同比 {show(yoy)}</div>
      </div>
    </div>
  );
}

export default function VolumePage() {
  const date = useBizDate();
  const [period, setPeriod] = useState("today");
  const [keyword, setKeyword] = useState("");
  const [query, setQuery] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["volume", date, period],
    queryFn: () => api<VolumePeriodData>("/api/volume", { query: { date, period } }),
    enabled: Boolean(date),
  });

  const detail = (data?.detail || []).filter((row) => {
    if (!query) return true;
    return [row.group_no, row.dealer, row.route]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });

  return (
    <>
      <PageHead title="单量分析" sub="按发运订单日期统计；支持今日、本周、本月、本季度及环比/同比" />
      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-body" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div className="toolbar">
            {PERIODS.map((item) => (
              <button
                key={item.key}
                className={`btn btn-sm${period === item.key ? " btn-primary" : ""}`}
                onClick={() => setPeriod(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {data && (
            <span className="small muted">
              {data.range.start} ~ {data.range.end}
            </span>
          )}
          <span className="small muted">对比：环比=上一周期，同比=去年同期</span>
        </div>
      </div>

      {isLoading && <Loading />}
      {error && <div className="widget-error">{(error as Error).message}</div>}

      {data && (
        <>
          <div className="grid cols-4" style={{ marginBottom: 14 }}>
            <CompareCard
              label="本期行数"
              value={data.totals.lines}
              unit="行"
              prev={data.prev.lines}
              yoy={data.yoy.lines}
            />
            <CompareCard
              label="本期金额"
              value={data.totals.amount}
              unit="万元"
              digits={2}
              prev={data.prev.amount}
              yoy={data.yoy.amount}
            />
            <CompareCard
              label="订单组数"
              value={data.totals.groups}
              unit="组"
              prev={data.prev.groups}
              yoy={data.yoy.groups}
            />
            <div className="panel">
              <div className="panel-body">
                <div className="small muted">当前周期</div>
                <div style={{ fontSize: 22, fontWeight: 700, margin: "6px 0" }}>
                  {PERIODS.find((item) => item.key === period)?.label}
                </div>
                <div className="small muted">对比上一周期 / 去年同期</div>
              </div>
            </div>
          </div>

          <div className="grid cols-2" style={{ marginBottom: 14 }}>
            <Panel title="线路"><BreakdownTable rows={data.breakdowns.route || []} /></Panel>
            <Panel title="区域"><BreakdownTable rows={data.breakdowns.region || []} /></Panel>
            <Panel title="库区"><BreakdownTable rows={data.breakdowns.zone || []} /></Panel>
            <Panel title="单据类型"><BreakdownTable rows={data.breakdowns.doc_type || []} /></Panel>
          </div>

          <div style={{ marginBottom: 14 }}>
            <Panel title="经销商"><BreakdownTable rows={data.breakdowns.dealer || []} /></Panel>
          </div>

          <Panel
            title="订单组明细"
            actions={
              <>
                <input
                  className="input"
                  style={{ width: 230, height: 30 }}
                  placeholder="搜索订单组号/经销商/线路"
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && setQuery(keyword.trim().toLowerCase())}
                />
                <button className="btn btn-sm" onClick={() => setQuery(keyword.trim().toLowerCase())}>
                  搜索
                </button>
              </>
            }
            flush
          >
            <div className="table-wrap" style={{ maxHeight: 420 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>订单组号</th>
                    <th>波次</th>
                    <th>经销商</th>
                    <th>线路</th>
                    <th>库区</th>
                    <th className="num">行数</th>
                    <th className="num">金额(万)</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.length === 0 && (
                    <tr>
                      <td colSpan={7} className="empty">暂无数据</td>
                    </tr>
                  )}
                  {detail.map((row) => (
                    <tr key={row.group_no}>
                      <td>{row.group_no}</td>
                      <td>{row.wave_no || "-"}</td>
                      <td>{row.dealer || "-"}</td>
                      <td>{row.route || "-"}</td>
                      <td>{row.zone || "-"}</td>
                      <td className="num">{num(row.lines)}</td>
                      <td className="num">{row.amount === null ? "-" : num(row.amount, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </>
  );
}
