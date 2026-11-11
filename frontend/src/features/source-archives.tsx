import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api, download } from "../lib/api";
import { num } from "../lib/format";
import { hasPerm, useApp } from "../lib/store";
import { Empty, Loading, Modal, Panel } from "../components/ui";

interface ArchivedDate {
  biz_date: string;
  rows: number;
  archived_at?: string | null;
}

interface ArchiveList {
  orders: ArchivedDate[];
  labor: ArchivedDate[];
  last_archive_scan?: string | null;
  auto_enabled?: boolean;
}

interface SourceArchiveRow {
  id: number;
  name: string;
  kind: string | null;
  rows: number;
  size: number;
  stored_bytes: number;
  scan_at: string | null;
  biz_dates: string | null;
  error: string | null;
  has_rows: number;
}

interface SourceArchiveList {
  rows: SourceArchiveRow[];
  total: number;
  bytes: number;
  keep_days: number;
  last_cleanup?: string | null;
}

interface OrderArchiveRow {
  seq: number;
  group_no: string;
  dealer: string;
  lines: number;
  amount: number | null;
  zone?: string | null;
  doc_type?: string | null;
  region?: string | null;
  route?: string | null;
  wave_no?: string | null;
  tms_status?: string | null;
  assignee?: string | null;
  included?: boolean;
}

interface LaborArchiveRow {
  person: string;
  pick_rows: number;
  pick_hours: number | null;
  pick_rate: number | null;
  check_rows: number;
  check_hours: number | null;
  check_rate: number | null;
}

interface ArchiveView {
  type: string;
  rows: OrderArchiveRow[] | LaborArchiveRow[];
  total?: number;
  summary?: { amount?: number };
  totals?: { pick_rows?: number; check_rows?: number };
  archived_at?: string | null;
}

interface PreviewSheet {
  name: string;
  headers: (string | number | null)[];
  rows: (string | number | null)[][];
}

interface ArchivePreview {
  name: string;
  scan_at: string | null;
  rows: number;
  biz_dates: string | null;
  sheets: PreviewSheet[];
}

const KIND_LABEL: Record<string, string> = {
  ship: "发运表",
  tms: "运输单状态",
  dealer: "经销商",
};

function fmtBytes(n: number | null | undefined): string {
  const value = Number(n) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function OrdersArchiveTable({ data }: { data: ArchiveView }) {
  const rows = (data.rows || []) as OrderArchiveRow[];
  return (
    <>
      <div className="small muted" style={{ marginBottom: 6 }}>
        共 {num(data.total)} 组 · 金额 {num(data.summary?.amount)} 元 · 归档 {data.archived_at || "-"}
      </div>
      <div className="table-wrap" style={{ maxHeight: "60vh" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>序号</th><th>订单组号</th><th>经销商</th><th className="num">行数</th>
              <th className="num">金额(元)</th><th>库区</th><th>单据类型</th><th>区域</th>
              <th>承运商</th><th>波次号</th><th>清洗</th><th>指派</th><th>计入</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={13}><Empty text="无数据" /></td></tr>}
            {rows.map((row) => (
              <tr key={row.seq}>
                <td>{row.seq}</td>
                <td>{row.group_no}</td>
                <td>{row.dealer}</td>
                <td className="num">{num(row.lines)}</td>
                <td className="num">{num(row.amount, 2)}</td>
                <td>{row.zone || "-"}</td>
                <td>{row.doc_type || "-"}</td>
                <td>{row.region || "-"}</td>
                <td>{row.route || "-"}</td>
                <td>{row.wave_no || "-"}</td>
                <td>{row.tms_status || "-"}</td>
                <td>{row.assignee || "-"}</td>
                <td>{row.included ? "计入" : "已移出"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function LaborArchiveTable({ data }: { data: ArchiveView }) {
  const rows = (data.rows || []) as LaborArchiveRow[];
  return (
    <>
      <div className="small muted" style={{ marginBottom: 6 }}>
        共 {rows.length} 人 · 拣货 {num(data.totals?.pick_rows)} 行 / 复核 {num(data.totals?.check_rows)} 行
        {" · 归档 "}{data.archived_at || "-"}
      </div>
      <div className="table-wrap" style={{ maxHeight: "60vh" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>人员</th><th className="num">拣货行</th><th className="num">拣货小时</th>
              <th className="num">拣货人效</th><th className="num">复核行</th>
              <th className="num">复核小时</th><th className="num">复核人效</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7}><Empty text="无数据" /></td></tr>}
            {rows.map((row, index) => (
              <tr key={`${row.person}-${index}`}>
                <td>{row.person}</td>
                <td className="num">{num(row.pick_rows)}</td>
                <td className="num">{num(row.pick_hours, 2)}</td>
                <td className="num">{row.pick_rate === null || row.pick_rate === undefined ? "-" : num(row.pick_rate, 1)}</td>
                <td className="num">{num(row.check_rows)}</td>
                <td className="num">{num(row.check_hours, 2)}</td>
                <td className="num">{row.check_rate === null || row.check_rate === undefined ? "-" : num(row.check_rate, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ArchiveBlock({ title, rows, type, onView, canExport }: {
  title: string;
  rows: ArchivedDate[];
  type: "orders" | "labor";
  onView: (type: "orders" | "labor", date: string) => void;
  canExport: boolean;
}) {
  return (
    <div>
      <div className="panel-sub" style={{ marginBottom: 6 }}><b>{title}</b></div>
      <div className="table-wrap" style={{ maxHeight: 260 }}>
        <table className="tbl">
          <thead>
            <tr><th>日期</th><th className="num">行数/条数</th><th>归档时间</th><th>操作</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={4}><Empty text="还没有归档" /></td></tr>}
            {rows.map((row) => (
              <tr key={row.biz_date}>
                <td>{row.biz_date}</td>
                <td className="num">{num(row.rows)}</td>
                <td className="small muted">{row.archived_at || ""}</td>
                <td className="nowrap">
                  <button className="btn btn-sm btn-ghost" onClick={() => onView(type, row.biz_date)}>查看</button>
                  {canExport && (
                    <button className="btn btn-sm btn-ghost"
                      onClick={() => download("/api/export/archive.csv", { type, from: row.biz_date, to: row.biz_date })}>
                      导出
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function SourceArchives() {
  const me = useApp((state) => state.me);
  const toast = useApp((state) => state.toast);
  const canExport = hasPerm(me, "action.export");

  const [viewTarget, setViewTarget] = useState<{ type: "orders" | "labor"; date: string } | null>(null);
  const [range, setRange] = useState({ type: "orders", from: "", to: "" });
  const [saFilter, setSaFilter] = useState({ kind: "all", q: "", from: "", to: "" });
  const [saDraft, setSaDraft] = useState({ kind: "all", q: "", from: "", to: "" });
  const [previewId, setPreviewId] = useState<number | null>(null);

  const list = useQuery({
    queryKey: ["archive-list"],
    queryFn: () => api<ArchiveList>("/api/archive/list"),
  });

  const view = useQuery({
    queryKey: ["archive-view", viewTarget?.type, viewTarget?.date],
    queryFn: () => api<ArchiveView>("/api/archive/view", { query: { type: viewTarget!.type, date: viewTarget!.date } }),
    enabled: Boolean(viewTarget),
  });

  const fileArchives = useQuery({
    queryKey: ["source-archives", saFilter],
    queryFn: () => api<SourceArchiveList>("/api/source-archives", {
      query: {
        kind: saFilter.kind === "all" ? undefined : saFilter.kind,
        q: saFilter.q || undefined,
        from: saFilter.from || undefined,
        to: saFilter.to || undefined,
      },
    }),
    enabled: false,
  });

  const preview = useQuery({
    queryKey: ["source-archive-preview", previewId],
    queryFn: () => api<ArchivePreview>(`/api/source-archive/${previewId}/preview`, { query: { limit: 100 } }),
    enabled: previewId !== null,
  });

  const onRangeExport = () => {
    if (!range.from || !range.to) {
      toast("请选择开始和结束日期", "err");
      return;
    }
    download("/api/export/archive.csv", { type: range.type, from: range.from, to: range.to });
  };

  const summary = fileArchives.data
    ? `共 ${num(fileArchives.data.total)} 个归档 · 占用 ${fmtBytes(fileArchives.data.bytes)} · 保留最近 ${num(fileArchives.data.keep_days)} 天`
      + (fileArchives.data.last_cleanup ? ` · 上次清理：${fileArchives.data.last_cleanup}` : "")
    : "";

  return (
    <>
      <Panel
        title="每日归档（订单组 / 人效）"
        sub={list.data
          ? `自动归档已开启：扫描发现新增/变更时覆盖受影响日期${list.data.last_archive_scan ? ` · 上次自动归档：${list.data.last_archive_scan}` : ""}`
          : undefined}
      >
        {list.isLoading && <Loading text="加载归档清单" />}
        {list.error && <Empty text={(list.error as Error).message} />}
        {list.data && (
          <>
            <div className="grid cols-2" style={{ gap: 16 }}>
              <ArchiveBlock title="订单组归档" rows={list.data.orders || []} type="orders"
                onView={(type, date) => setViewTarget({ type, date })} canExport={canExport} />
              <ArchiveBlock title="人效归档" rows={list.data.labor || []} type="labor"
                onView={(type, date) => setViewTarget({ type, date })} canExport={canExport} />
            </div>
            {canExport && (
              <div className="toolbar" style={{ marginTop: 12, gap: 8, alignItems: "center" }}>
                <span className="small muted">区间导出：</span>
                <select className="select" style={{ height: 30 }} value={range.type}
                  onChange={(event) => setRange((prev) => ({ ...prev, type: event.target.value }))}>
                  <option value="orders">订单组归档</option>
                  <option value="labor">人效归档</option>
                </select>
                <input className="input" type="date" style={{ height: 30, width: 150 }} value={range.from}
                  onChange={(event) => setRange((prev) => ({ ...prev, from: event.target.value }))} />
                <span>—</span>
                <input className="input" type="date" style={{ height: 30, width: 150 }} value={range.to}
                  onChange={(event) => setRange((prev) => ({ ...prev, to: event.target.value }))} />
                <button className="btn btn-sm btn-primary" onClick={onRangeExport}>导出 CSV</button>
              </div>
            )}
          </>
        )}
      </Panel>

      <div style={{ height: 14 }} />

      <Panel
        title="扫描文件归档"
        sub={summary || undefined}
        actions={
          <button className="btn btn-sm" onClick={() => { setSaFilter(saDraft); void fileArchives.refetch(); }}>
            搜索
          </button>
        }
        flush
      >
        <div className="toolbar" style={{ padding: "12px 14px", gap: 8, alignItems: "center" }}>
          <select className="select" style={{ height: 30, width: 130 }} value={saDraft.kind}
            onChange={(event) => setSaDraft((prev) => ({ ...prev, kind: event.target.value }))}>
            <option value="all">全部类型</option>
            <option value="ship">发运表</option>
            <option value="tms">运输单状态</option>
            <option value="dealer">经销商</option>
          </select>
          <input className="input" style={{ height: 30, width: 180 }} placeholder="文件名"
            value={saDraft.q} onChange={(event) => setSaDraft((prev) => ({ ...prev, q: event.target.value }))}
            onKeyDown={(event) => { if (event.key === "Enter") { setSaFilter(saDraft); void fileArchives.refetch(); } }} />
          <input className="input" type="date" style={{ height: 30, width: 150 }} value={saDraft.from}
            onChange={(event) => setSaDraft((prev) => ({ ...prev, from: event.target.value }))} />
          <span>—</span>
          <input className="input" type="date" style={{ height: 30, width: 150 }} value={saDraft.to}
            onChange={(event) => setSaDraft((prev) => ({ ...prev, to: event.target.value }))} />
        </div>
        {fileArchives.isLoading && <Loading text="加载归档" />}
        {fileArchives.error && <Empty text={(fileArchives.error as Error).message} />}
        {fileArchives.data && fileArchives.data.rows.length === 0 && (
          <Empty text="还没有归档：把文件保存到数据源目录后点「立即扫描」" />
        )}
        {fileArchives.data && fileArchives.data.rows.length > 0 && (
          <div className="table-wrap" style={{ maxHeight: 420 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>扫描时间</th><th>文件</th><th>类型</th><th className="num">行数</th>
                  <th className="num">大小</th><th>涉及日期</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                {fileArchives.data.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="nowrap">{row.scan_at || ""}</td>
                    <td>
                      <span title={row.name}>{row.name}</span>
                      {row.error && <div className="small" style={{ color: "#c92a2a" }}>{row.error}</div>}
                    </td>
                    <td>{KIND_LABEL[row.kind || ""] || row.kind || "-"}</td>
                    <td className="num">{num(row.rows)}</td>
                    <td className="num" title={`源文件 ${fmtBytes(row.size)}`}>{fmtBytes(row.stored_bytes || 0)}</td>
                    <td className="small muted">{row.biz_dates || "-"}</td>
                    <td className="nowrap">
                      <button className="btn btn-sm btn-ghost" onClick={() => setPreviewId(row.id)}>预览</button>
                      {canExport && (
                        <button className="btn btn-sm btn-ghost"
                          onClick={() => download("/api/export/source-archive.csv", { id: row.id })}>
                          导出CSV
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {viewTarget && (
        <Modal
          title={`${viewTarget.type === "labor" ? "人效归档" : "订单组归档"} · ${viewTarget.date}`}
          wide
          onClose={() => setViewTarget(null)}
          footer={<button className="btn" onClick={() => setViewTarget(null)}>关闭</button>}
        >
          {view.isLoading && <Loading text="加载归档明细" />}
          {view.error && <Empty text={(view.error as Error).message} />}
          {view.data && (viewTarget.type === "labor"
            ? <LaborArchiveTable data={view.data} />
            : <OrdersArchiveTable data={view.data} />)}
        </Modal>
      )}

      {previewId !== null && (
        <Modal
          title="归档预览"
          wide
          onClose={() => setPreviewId(null)}
          footer={<button className="btn" onClick={() => setPreviewId(null)}>关闭</button>}
        >
          {preview.isLoading && <Loading text="加载预览" />}
          {preview.error && <Empty text={(preview.error as Error).message} />}
          {preview.data && (
            <>
              <div className="small muted" style={{ marginBottom: 8 }}>
                {preview.data.name} · {preview.data.scan_at || ""} · 共 {num(preview.data.rows)} 行
                {preview.data.biz_dates ? ` · 涉及日期 ${preview.data.biz_dates}` : ""}
              </div>
              {(preview.data.sheets || []).map((sheet, index) => (
                <div key={`${sheet.name}-${index}`}>
                  <div className="small" style={{ margin: "10px 0 4px" }}>
                    <b>{sheet.name}</b>（预览前 {(sheet.rows || []).length} 行，表头 {(sheet.headers || []).length} 列）
                  </div>
                  <div className="table-wrap" style={{ maxHeight: "55vh" }}>
                    <table className="tbl">
                      <thead>
                        <tr>{(sheet.headers || []).map((header, col) => <th key={col}>{String(header ?? "")}</th>)}</tr>
                      </thead>
                      <tbody>
                        {(sheet.rows || []).map((row, rowIndex) => (
                          <tr key={rowIndex}>
                            {row.map((value, col) => (
                              <td key={col}>{value === null || value === undefined ? "" : String(value)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
