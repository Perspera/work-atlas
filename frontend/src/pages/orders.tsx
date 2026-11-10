import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import { api, download } from "../lib/api";
import { num } from "../lib/format";
import { useBizDate, useMeta } from "../lib/hooks";
import { hasPerm, useApp } from "../lib/store";
import { Badge, Empty, Loading, Modal, PageHead, Panel } from "../components/ui";

interface OrderGroupRow {
  seq: number;
  group_no: string;
  group_no_label?: string;
  dealer: string;
  lines: number;
  amount: number | null;
  zone: string | null;
  doc_type: string | null;
  freight_free: string | null;
  region: string | null;
  route: string | null;
  wave_no: string;
  tms_status: string | null;
  assignee: string | null;
  note: string | null;
  included: number;
}

interface OrderGroupsData {
  mode: string;
  total: number;
  page: number;
  size: number;
  summary: { groups: number; lines: number; amount: number | null };
  rows: OrderGroupRow[];
  archived_at: string | null;
  archive_rows: number | null;
}

interface WaveRow {
  wave_no: string;
  pending?: boolean;
}

interface Filters {
  mode: "live" | "archive";
  wave: string;
  route: string;
  region: string;
  q: string;
  included: string;
  sort: string;
  page: number;
  size: number;
}

function EditDialog({
  row,
  date,
  onClose,
  onSaved,
}: {
  row: OrderGroupRow;
  date: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useApp((state) => state.toast);
  const [route, setRoute] = useState(row.route || "");
  const [region, setRegion] = useState(row.region || "");
  const [assignee, setAssignee] = useState(row.assignee || "");
  const [note, setNote] = useState(row.note || "");
  const [include, setInclude] = useState(Boolean(row.included));
  const [busy, setBusy] = useState(false);
  const path = `/api/order-groups/${encodeURIComponent(row.group_no)}`;

  const save = async () => {
    setBusy(true);
    try {
      await api(path, {
        method: "PUT",
        query: { date },
        body: {
          route_override: route.trim(),
          region_override: region.trim(),
          assign_override: assignee.trim(),
          note: note.trim(),
          include: include ? 1 : 0,
        },
      });
      toast("已保存", "ok");
      onSaved();
    } catch (error) {
      toast((error as Error).message, "err");
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await api(path, { method: "DELETE", query: { date } });
      toast("已恢复默认", "ok");
      onSaved();
    } catch (error) {
      toast((error as Error).message, "err");
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`编辑订单组 ${row.group_no_label || row.group_no}`}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-danger" disabled={busy} onClick={reset}>恢复默认</button>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>保存</button>
        </>
      }
    >
      <div className="small muted" style={{ marginBottom: 10 }}>
        留空表示按默认口径（经销商映射 / 调拨规则 / 运输单）。波次号不可修改。
      </div>
      <div className="grid cols-2">
        <div className="field">
          <label>承运商 / 线路</label>
          <input className="input" value={route} placeholder={`默认：${row.route || "未映射"}`}
            onChange={(event) => setRoute(event.target.value)} />
        </div>
        <div className="field">
          <label>区域</label>
          <input className="input" value={region} placeholder={`默认：${row.region || "未映射"}`}
            onChange={(event) => setRegion(event.target.value)} />
        </div>
        <div className="field">
          <label>指派（实际承运商）</label>
          <input className="input" value={assignee} onChange={(event) => setAssignee(event.target.value)} />
        </div>
        <div className="field">
          <label>备注</label>
          <input className="input" value={note} onChange={(event) => setNote(event.target.value)} />
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={include} onChange={(event) => setInclude(event.target.checked)} />
        计入本波次（取消勾选=移出）
      </label>
    </Modal>
  );
}

export default function OrdersPage() {
  const date = useBizDate();
  const meta = useMeta();
  const me = useApp((state) => state.me);
  const toast = useApp((state) => state.toast);
  const [searchParams] = useSearchParams();
  const initialWave = searchParams.get("wave") || "";
  const [filters, setFilters] = useState<Filters>({
    mode: "live",
    wave: initialWave,
    route: "",
    region: "",
    q: "",
    included: "all",
    sort: "reg",
    page: 1,
    size: 100,
  });
  const [draft, setDraft] = useState({
    wave: initialWave,
    route: "",
    region: "",
    q: "",
    included: "all",
    sort: "reg",
  });
  const [editing, setEditing] = useState<OrderGroupRow | null>(null);
  const canEdit = hasPerm(me, "action.orders.override");
  const canArchive = hasPerm(me, "action.orders.archive");

  const waves = useQuery({
    queryKey: ["waves", date, "options"],
    queryFn: () => api<{ rows: WaveRow[] }>("/api/waves", { query: { date } }),
    enabled: Boolean(date),
  });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["order-groups", date, filters],
    queryFn: () =>
      api<OrderGroupsData>("/api/order-groups", {
        query: {
          date,
          mode: filters.mode,
          page: filters.page,
          size: filters.size,
          wave: filters.wave,
          route: filters.route,
          region: filters.region,
          q: filters.q,
          included: filters.included,
          sort: filters.sort,
        },
      }),
    enabled: Boolean(date),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;

  const applySearch = () => {
    setFilters((prev) => ({ ...prev, ...draft, page: 1 }));
  };

  const saveOverride = async (row: OrderGroupRow, include: number, okText: string) => {
    try {
      await api(`/api/order-groups/${encodeURIComponent(row.group_no)}`, {
        method: "PUT",
        query: { date },
        body: { include },
      });
      toast(okText, "ok");
      refetch();
    } catch (err) {
      toast((err as Error).message, "err");
    }
  };

  const archive = async () => {
    const force = Boolean(data?.archived_at);
    if (!window.confirm(force ? "会用当前数据覆盖该日期的存档快照（留审计）。确定？" : `把当前订单组台账按 ${date} 存档。确定？`)) {
      return;
    }
    try {
      const result = await api<{ count: number }>("/api/archive", {
        method: "POST",
        body: { date, force },
      });
      toast(`已存档 ${result.count} 行`, "ok");
      refetch();
    } catch (err) {
      toast((err as Error).message, "err");
    }
  };

  return (
    <>
      <PageHead
        title="订单组登记"
        sub={`业务日期 ${date} · 字段与现行《单据登记表》一致；可改区域/承运商/指派/备注，可移出或恢复`}
      >
        <button className="btn" disabled={!canArchive || filters.mode !== "live"} onClick={archive}>
          {data?.archived_at ? "重新存档" : date === meta.data?.today ? "存档今日" : "存档当日"}
        </button>
        <button
          className="btn"
          onClick={() => download("/api/export/order-groups.csv", { date, mode: filters.mode, wave: filters.wave, sort: filters.sort })}
        >
          导出 CSV
        </button>
      </PageHead>

      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="panel-body" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div className="toolbar">
            {(["live", "archive"] as const).map((mode) => (
              <button
                key={mode}
                className={`btn btn-sm${filters.mode === mode ? " btn-primary" : ""}`}
                onClick={() => setFilters((prev) => ({ ...prev, mode, page: 1 }))}
              >
                {mode === "live" ? "实时登记" : "存档快照"}
              </button>
            ))}
          </div>
          <select
            className="select"
            style={{ height: 30, minWidth: 170 }}
            value={draft.wave}
            onChange={(event) => setDraft((prev) => ({ ...prev, wave: event.target.value }))}
          >
            <option value="">全部波次</option>
            {(waves.data?.rows || []).map((row) => (
              <option key={row.wave_no} value={row.wave_no}>
                {row.wave_no}
                {row.pending ? "（待数据）" : ""}
              </option>
            ))}
          </select>
          <input className="input" style={{ height: 30, width: 150 }} placeholder="承运商/线路"
            value={draft.route} onChange={(event) => setDraft((prev) => ({ ...prev, route: event.target.value }))} />
          <input className="input" style={{ height: 30, width: 110 }} placeholder="区域"
            value={draft.region} onChange={(event) => setDraft((prev) => ({ ...prev, region: event.target.value }))} />
          <input className="input" style={{ height: 30, width: 200 }} placeholder="订单组号/经销商/波次"
            value={draft.q} onChange={(event) => setDraft((prev) => ({ ...prev, q: event.target.value }))}
            onKeyDown={(event) => event.key === "Enter" && applySearch()} />
          <select className="select" style={{ height: 30 }} value={draft.included}
            onChange={(event) => setDraft((prev) => ({ ...prev, included: event.target.value }))}>
            <option value="all">全部</option>
            <option value="1">仅计入</option>
            <option value="0">已移出</option>
          </select>
          <select className="select" style={{ height: 30 }} value={draft.sort}
            onChange={(event) => setDraft((prev) => ({ ...prev, sort: event.target.value }))}>
            <option value="reg">按登记顺序</option>
            <option value="wave">按波次号</option>
          </select>
          <button className="btn btn-sm" onClick={applySearch}>查询</button>
          <span className="small muted">
            {filters.mode === "archive"
              ? `存档时间：${data?.archived_at || "-"}（只读）`
              : data?.archived_at
                ? `该日已存档：${data.archived_at}（${data.archive_rows} 行）`
                : "尚未存档"}
          </span>
        </div>
      </div>

      <Panel
        title={`${filters.mode === "archive" ? "订单组（存档快照）" : "订单组"} · ${date}`}
        sub={data ? `共 ${num(data.summary.groups)} 组 / ${num(data.summary.lines)} 行${data.summary.amount === null ? "" : ` / 金额 ${num(data.summary.amount)} 元`}` : undefined}
        flush
      >
        {isLoading && <Loading />}
        {error && <Empty text={(error as Error).message} />}
        {data && (
          <>
            <div className="table-wrap">
              <table className="tbl" style={{ minWidth: 1180 }}>
                <thead>
                  <tr>
                    <th className="num">序号</th>
                    <th>订单组号</th>
                    <th>经销商</th>
                    <th className="num">行数</th>
                    <th className="num">金额(元)</th>
                    <th>库区</th>
                    <th>单据类型</th>
                    <th>是否免运费（预留）</th>
                    <th>区域</th>
                    <th>承运商</th>
                    <th>波次号</th>
                    <th>清洗</th>
                    <th>指派</th>
                    <th>备注</th>
                    {canEdit && filters.mode === "live" && <th>操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.length === 0 && (
                    <tr>
                      <td colSpan={15}>
                        <Empty
                          text={
                            filters.mode === "archive"
                              ? "该日期还没有存档（切到「实时登记」后点「存档今日」）"
                              : filters.wave
                                ? "该波次还没有订单组"
                                : "当天还没有订单组（先登记波次）"
                          }
                        />
                      </td>
                    </tr>
                  )}
                  {data.rows.map((row) => {
                    const moved = !row.included;
                    return (
                      <tr key={row.group_no} className={moved ? "moved" : ""}>
                        <td className="num">{row.seq}</td>
                        <td>
                          <span style={moved ? { textDecoration: "line-through", color: "#98a2b3" } : undefined}>
                            {row.group_no_label || row.group_no}
                          </span>
                          {moved && <> <Badge kind="danger">已移出</Badge></>}
                        </td>
                        <td>{row.dealer}</td>
                        <td className="num">{num(row.lines)}</td>
                        <td className="num">{row.amount === null ? "-" : num(row.amount)}</td>
                        <td>{row.zone || "-"}</td>
                        <td>{row.doc_type || "-"}</td>
                        <td>{row.freight_free || "-"}</td>
                        <td>{row.region || "未映射"}</td>
                        <td className="nowrap">{row.route || "未映射"}</td>
                        <td>{row.wave_no}</td>
                        <td>
                          {row.tms_status ? (
                            <Badge kind={row.tms_status === "已释放" ? "ok" : "info"}>{row.tms_status}</Badge>
                          ) : (
                            <Badge kind="warn">未匹配</Badge>
                          )}
                        </td>
                        <td>{row.assignee || "-"}</td>
                        <td className="small muted">{row.note || ""}</td>
                        {canEdit && filters.mode === "live" && (
                          <td className="nowrap">
                            <button className="btn btn-sm btn-ghost" onClick={() => setEditing(row)}>编辑</button>
                            {moved ? (
                              <button className="btn btn-sm btn-ghost" onClick={() => void saveOverride(row, 1, "已恢复")}>
                                恢复
                              </button>
                            ) : (
                              <button
                                className="btn btn-sm btn-danger"
                                onClick={() => {
                                  if (window.confirm("移出后该订单组不再计入当天单量与进度，可在「已移出」里恢复。确定移出？")) {
                                    void saveOverride(row, 0, "已移出");
                                  }
                                }}
                              >
                                移出
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <span>第 {data.page} / {totalPages} 页</span>
              <button className="btn btn-sm" disabled={data.page <= 1}
                onClick={() => setFilters((prev) => ({ ...prev, page: prev.page - 1 }))}>上一页</button>
              <button className="btn btn-sm" disabled={data.page >= totalPages}
                onClick={() => setFilters((prev) => ({ ...prev, page: prev.page + 1 }))}>下一页</button>
            </div>
          </>
        )}
      </Panel>

      {editing && (
        <EditDialog
          row={editing}
          date={date}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refetch();
          }}
        />
      )}
    </>
  );
}
