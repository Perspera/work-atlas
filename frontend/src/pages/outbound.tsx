import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { api, download } from "../lib/api";
import { num } from "../lib/format";
import { hasPerm, useApp } from "../lib/store";
import { Empty, Kpi, KpiBand, Loading, PageHead, Panel } from "../components/ui";

interface OutboundDate {
  biz_date: string;
  rows: number;
  archived_at: string;
  name: string;
}

interface OutboundMeta {
  biz_date: string;
  name: string;
  rows: number;
  updated_at: string;
  headers: string[];
  date_columns: string[];
  sheet: string;
  sheets: { name: string | null; headers: string[]; rows: number }[];
  stored_bytes?: number;
}

interface OutboundMetaResponse {
  archive: OutboundMeta | null;
  dates: OutboundDate[];
}

interface OutboundQueryData {
  meta: {
    biz_date: string;
    name: string;
    rows: number;
    updated_at: string;
    headers: string[];
    date_columns: string[];
    sheet: string;
  };
  total: number;
  page: number;
  page_size: number;
  pages: number;
  rows: (string | number | boolean | null)[][];
}

interface Condition {
  col: string;
  op: "contains" | "eq";
  value: string;
}

interface SearchState {
  dateCol: string;
  from: string;
  to: string;
  conds: Condition[];
}

const PREFERRED_COLS = ["状态", "订单类型", "区"];
const PAGE_SIZE = 50;

function fmtBytes(value: number | undefined) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function initialState(meta: OutboundMeta): SearchState {
  return {
    dateCol: meta.date_columns.includes("订单日期") ? "订单日期" : meta.date_columns[0] || "",
    from: "",
    to: "",
    conds: PREFERRED_COLS.map((col) => ({
      col: meta.headers.includes(col) ? col : meta.headers[0] || "",
      op: "contains",
      value: "",
    })),
  };
}

/** 与原前端一致：col/op/val 允许重复出现，页码/页大小只在查询时带上。 */
function buildQuery(date: string, search: SearchState, page?: number) {
  const params = new URLSearchParams();
  search.conds.forEach((cond) => {
    const value = cond.value.trim();
    if (!cond.col || !value) return;
    params.append("col", cond.col);
    params.append("op", cond.op);
    params.append("val", value);
  });
  if (date) params.set("date", date);
  if (search.dateCol) params.set("date_col", search.dateCol);
  if (search.from) params.set("from", search.from);
  if (search.to) params.set("to", search.to);
  if (page !== undefined) {
    params.set("page", String(page));
    params.set("page_size", String(PAGE_SIZE));
  }
  return params.toString();
}

function ArchiveView({ date, meta }: { date: string; meta: OutboundMeta }) {
  const [draft, setDraft] = useState<SearchState>(() => initialState(meta));
  const [applied, setApplied] = useState<SearchState>(() => initialState(meta));
  const [page, setPage] = useState(1);

  const { data, isLoading, error } = useQuery({
    queryKey: ["outbound-archive-rows", date, applied, page],
    queryFn: () =>
      api<OutboundQueryData>(`/api/outbound-archive/query?${buildQuery(date, applied, page)}`),
  });

  // 数值列：表头与数据一起右对齐，否则数字右对齐、表头左对齐会错位
  const numericCols = new Set<number>(
    data
      ? data.meta.headers
          .map((_header, index) => (data.rows.some((row) => typeof row[index] === "number") ? index : -1))
          .filter((index) => index >= 0)
      : [],
  );

  const updateCond = (index: number, patch: Partial<Condition>) => {
    setDraft((prev) => ({
      ...prev,
      conds: prev.conds.map((cond, i) => (i === index ? { ...cond, ...patch } : cond)),
    }));
  };

  const apply = () => {
    setApplied(draft);
    setPage(1);
  };

  const reset = () => {
    const next = initialState(meta);
    setDraft(next);
    setApplied(next);
    setPage(1);
  };

  return (
    <>
      <div className="grid cols-2" style={{ marginBottom: 10, gap: 10 }}>
        <div className="field" style={{ margin: 0 }}>
          <label>日期列</label>
          <select
            className="select"
            style={{ height: 30 }}
            value={draft.dateCol}
            onChange={(event) => setDraft((prev) => ({ ...prev, dateCol: event.target.value }))}
          >
            {meta.date_columns.length ? (
              meta.date_columns.map((col) => (
                <option key={col} value={col}>
                  {col}
                </option>
              ))
            ) : (
              <option value="">（无日期列）</option>
            )}
          </select>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>日期区间</label>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              className="input"
              type="date"
              style={{ height: 30, flex: 1 }}
              value={draft.from}
              onChange={(event) => setDraft((prev) => ({ ...prev, from: event.target.value }))}
            />
            <span>—</span>
            <input
              className="input"
              type="date"
              style={{ height: 30, flex: 1 }}
              value={draft.to}
              onChange={(event) => setDraft((prev) => ({ ...prev, to: event.target.value }))}
            />
          </div>
        </div>
      </div>

      <div className="field">
        <label>按文件表头内容筛选（最多 3 个条件）</label>
        {draft.conds.map((cond, index) => (
          <div
            key={index}
            style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}
          >
            <select
              className="select"
              style={{ height: 30, maxWidth: 220 }}
              value={cond.col}
              onChange={(event) => updateCond(index, { col: event.target.value })}
            >
              {meta.headers.map((header) => (
                <option key={header} value={header}>
                  {header}
                </option>
              ))}
            </select>
            <select
              className="select"
              style={{ height: 30, width: 100 }}
              value={cond.op}
              onChange={(event) => updateCond(index, { op: event.target.value as "contains" | "eq" })}
            >
              <option value="contains">包含</option>
              <option value="eq">等于</option>
            </select>
            <input
              className="input"
              placeholder="筛选值（留空不筛选）"
              style={{ height: 30, flex: 1, minWidth: 150 }}
              value={cond.value}
              onChange={(event) => updateCond(index, { value: event.target.value })}
            />
          </div>
        ))}
      </div>

      <div className="toolbar" style={{ marginBottom: 10 }}>
        <button className="btn btn-primary" onClick={apply}>
          查询
        </button>
        <button className="btn" onClick={reset}>
          重置
        </button>
        <button className="btn" onClick={() => download(`/api/export/outbound-archive.csv?${buildQuery(date, draft)}`)}>
          导出筛选 CSV
        </button>
        <span className="small muted">
          {data ? `筛选后 ${num(data.total)} 行 / 全部 ${num(data.meta.rows)} 行` : ""}
        </span>
      </div>

      {isLoading && <div className="small muted">查询中…</div>}
      {error && <Empty text={(error as Error).message} />}
      {data && (
        <>
          {data.rows.length === 0 ? (
            <Empty text="没有符合条件的数据" />
          ) : (
            <div className="table-wrap" style={{ maxHeight: "62vh" }}>
              <table className="tbl oa-data" style={{ minWidth: 3600 }}>
                <thead>
                  <tr>
                    <th>#</th>
                    {data.meta.headers.map((header, index) => (
                      <th key={index} className={numericCols.has(index) ? "num" : undefined}>{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      <td>{(data.page - 1) * data.page_size + rowIndex + 1}</td>
                      {data.meta.headers.map((_header, index) => {
                        const value = row[index];
                        if (value === null || value === undefined) return <td key={index}>-</td>;
                        if (typeof value === "number") {
                          return (
                            <td key={index} className="num">
                              {num(value, 2)}
                            </td>
                          );
                        }
                        return <td key={index}>{String(value)}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="pager">
            <span>
              共 {num(data.total)} 行 · 第 {data.page}/{data.pages} 页
            </span>
            <button
              className="btn btn-sm"
              disabled={data.page <= 1}
              onClick={() => setPage(Math.max(1, data.page - 1))}
            >
              上一页
            </button>
            <button
              className="btn btn-sm"
              disabled={data.page >= data.pages}
              onClick={() => setPage(data.page + 1)}
            >
              下一页
            </button>
          </div>
        </>
      )}
    </>
  );
}

export default function OutboundPage() {
  const me = useApp((state) => state.me);
  const toast = useApp((state) => state.toast);
  const canScan = hasPerm(me, "action.scan");
  const [date, setDate] = useState("");
  const [dates, setDates] = useState<OutboundDate[]>([]);

  const metaQuery = useQuery({
    queryKey: ["outbound-archive", date],
    queryFn: () => api<OutboundMetaResponse>("/api/outbound-archive", { query: { date } }),
  });

  useEffect(() => {
    const rows = metaQuery.data?.dates;
    if (!rows) return;
    setDates(rows);
    if (!date && rows.length) setDate(rows[0].biz_date);
  }, [date, metaQuery.data]);

  const scan = useMutation({
    mutationFn: () => api("/api/scan", { method: "POST" }),
    onSuccess: () => {
      toast("扫描完成", "ok");
      void metaQuery.refetch();
    },
    onError: (err) => toast((err as Error).message, "err"),
  });

  const archive = metaQuery.data?.archive || null;
  const sub = metaQuery.isLoading
    ? "加载中…"
    : archive
      ? `${archive.biz_date || date} · ${archive.name || ""} · 更新 ${archive.updated_at || "-"} · 共 ${num(
          archive.rows,
        )} 行 · ${num(archive.headers.length)} 列 · ${fmtBytes(archive.stored_bytes)}`
      : "尚未归档";

  return (
    <>
      <PageHead
        title="出库归档"
        sub="读取【出库】出库流程节点时间跟踪(配送中心)文件；按业务日保存归档，可按日期、表头筛选和导出"
      >
        {canScan && (
          <button className="btn btn-primary" disabled={scan.isPending} onClick={() => scan.mutate()}>
            {scan.isPending ? "扫描中…" : "立即扫描"}
          </button>
        )}
      </PageHead>

      {archive && (
        <KpiBand cols={4}>
          <Kpi label="归档行数" value={num(archive.rows)} unit="行"
            sub={`业务日 ${archive.biz_date || date}`} />
          <Kpi label="文件大小" value={num((archive.stored_bytes || 0) / 1024 / 1024, 2)} unit="MB"
            sub={`${num(archive.sheets.reduce((sum, sheet) => sum + sheet.rows, 0))} 行 · ${num(archive.sheets.length)} 个工作表`} />
          <Kpi label="字段数" value={num(archive.headers.length)} unit="列" sub="横向滚动 · 前 3 列冻结" />
          <Kpi label="归档日期" value={num(dates.length)} unit="天"
            sub={dates[0]?.biz_date ? `最新 ${dates[0].biz_date}` : "—"} />
        </KpiBand>
      )}

      <Panel
        title="归档数据"
        sub={sub}
        actions={
          <select
            className="select"
            style={{ height: 30, minWidth: 160 }}
            value={date}
            onChange={(event) => setDate(event.target.value)}
          >
            {dates.map((item) => (
              <option key={item.biz_date} value={item.biz_date}>
                {item.biz_date}（{num(item.rows)} 行）
              </option>
            ))}
          </select>
        }
      >
        {metaQuery.isLoading && <Loading />}
        {metaQuery.error && <Empty text={(metaQuery.error as Error).message} />}
        {!metaQuery.isLoading && !metaQuery.error && !archive && (
          <Empty text="还没有出库归档：把【出库】出库流程节点时间跟踪(配送中心) 文件放进数据源目录，再点「立即扫描」" />
        )}
        {archive && (
          <ArchiveView
            key={`${date}-${archive.updated_at}-${archive.rows}`}
            date={date || archive.biz_date}
            meta={archive}
          />
        )}
      </Panel>
    </>
  );
}
