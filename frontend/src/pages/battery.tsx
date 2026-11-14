import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api, download } from "../lib/api";
import { num, pct } from "../lib/format";
import { useBizDate, useMeta } from "../lib/hooks";
import { hasPerm, useApp } from "../lib/store";
import { Badge, Empty, Kpi, KpiBand, Loading, Modal, PageHead, Panel, Seg } from "../components/ui";

interface BatteryRow {
  order_date: string;
  reg_date: string | null;
  group_no: string;
  dealer_full: string | null;
  dealer_short: string | null;
  part_code: string;
  part_name: string | null;
  lines: number;
  qty: number;
  amount: number | null;
  picked: number;
  checked: number;
  zone: string | null;
  doc_type: string | null;
  freight_free: string | null;
  region: string | null;
  carrier: string | null;
  dest_city: string | null;
  address: string | null;
  address_matched: number;
  confirmed: number;
  incomplete: boolean;
  biz_date?: string;
}

interface BatteryData {
  total: number;
  page: number;
  pages: number;
  page_size: number;
  rows: BatteryRow[];
  summary: { lines: number; qty: number; amount: number | null; picked: number; checked: number };
  parts_count: number;
  has_parts: boolean;
}

interface DealerForm {
  dealer_full: string;
  dealer_short: string;
  zone: string;
  doc_type: string;
  freight_free: string;
  region: string;
  carrier: string;
  dest_city: string;
  address: string;
}

function toDealerForm(row: BatteryRow): DealerForm {
  return {
    dealer_full: row.dealer_full || "",
    dealer_short: row.dealer_short || "",
    zone: row.zone || "",
    doc_type: row.doc_type || "",
    freight_free: row.freight_free || "",
    region: row.region || "",
    carrier: row.carrier || "",
    dest_city: row.dest_city || "",
    address: row.address || "",
  };
}

const keyOf = (row: BatteryRow) => ({ order_date: row.order_date, group_no: row.group_no, part_code: row.part_code });

export default function BatteryPage() {
  const date = useBizDate();
  const meta = useMeta();
  const me = useApp((state) => state.me);
  const toast = useApp((state) => state.toast);
  const canManage = hasPerm(me, "action.battery.manage");

  const [mode, setMode] = useState<"live" | "archive">("live");
  const [filters, setFilters] = useState({ from: date, to: date, q: "", status: "", page: 1 });
  const [draft, setDraft] = useState({ from: date, to: date, q: "", status: "" });
  const [selected, setSelected] = useState<BatteryRow[]>([]);
  const [addressRow, setAddressRow] = useState<BatteryRow | null>(null);
  const [dealerForm, setDealerForm] = useState<DealerForm | null>(null);
  const partsInput = useRef<HTMLInputElement>(null);
  const today = meta.data?.today || date;

  const path = mode === "archive" ? "/api/battery/archive" : "/api/battery/rows";

  const main = useQuery({
    queryKey: ["battery", mode, filters],
    queryFn: () =>
      api<BatteryData>(path, {
        query: {
          ...(mode === "archive"
            ? { from: filters.from, to: filters.to }
            : { order_from: filters.from, order_to: filters.to }),
          q: filters.q,
          status: filters.status,
          page: filters.page,
          page_size: 50,
        },
      }),
    enabled: Boolean(date),
  });

  const todayRows = useQuery({
    queryKey: ["battery", "today", today],
    queryFn: () =>
      api<BatteryData>("/api/battery/rows", {
        query: { reg_from: today, reg_to: today, status: "confirmed", page: 1, page_size: 5000 },
      }),
    enabled: Boolean(today) && mode === "live",
  });

  const refresh = () => {
    void main.refetch();
    void todayRows.refetch();
  };

  const confirmItems = async (items: BatteryRow[]) => {
    if (!items.length) {
      toast("请先勾选待登记行", "warn");
      return;
    }
    try {
      const result = await api<{ confirmed: number }>("/api/battery/confirm", {
        method: "POST",
        body: { items: items.map(keyOf) },
      });
      toast(`已登记 ${result.confirmed || 0} 条`, "ok");
      setSelected([]);
      refresh();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  const unconfirm = async (row: BatteryRow) => {
    try {
      await api("/api/battery/unconfirm", { method: "POST", body: { items: [keyOf(row)] } });
      toast("已取消登记", "ok");
      refresh();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  const saveDealer = async () => {
    if (!dealerForm) return;
    try {
      await api("/api/battery/dealers", { method: "POST", body: dealerForm });
      toast("地址已保存，后续自动匹配", "ok");
      setAddressRow(null);
      setDealerForm(null);
      refresh();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  const archive = async () => {
    const day = mode === "archive" ? filters.from : today;
    if (!day) {
      toast("无法确定实际登记日期", "warn");
      return;
    }
    if (!window.confirm(`按 ${day} 存档当天动力电池明细？已有存档会覆盖。`)) return;
    try {
      await api("/api/battery/archive", { method: "POST", body: { date: day, force: true } });
      toast(`已存档 ${day}`, "ok");
      setMode("archive");
      setFilters((prev) => ({ ...prev, from: day, to: day, page: 1 }));
      setDraft((prev) => ({ ...prev, from: day, to: day }));
      refresh();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  const importParts = async (file: File) => {
    try {
      const res = await fetch("/api/battery/parts/import", {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-Dashboard-Client": "1" },
        body: file,
      });
      const data = (await res.json()) as { count?: number; error?: string };
      if (!res.ok) throw new Error(data.error || "导入失败");
      toast(`备件表已导入 ${data.count || 0} 条`, "ok");
      refresh();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  const rows = main.data?.rows || [];
  const allSelectable = rows.filter((row) => !row.confirmed);

  return (
    <>
      <PageHead
        title="动力电池登记"
        sub="按订单组号自动列出动力电池候选，人工确认登记；数量/金额只取该组该备件编码的动力电池行"
      >
        {canManage && (
          <label className="btn" style={{ cursor: "pointer" }}>
            上传动力电池备件表
            <input ref={partsInput} type="file" accept=".xlsx,.xlsm,.csv" style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importParts(file);
                event.target.value = "";
              }} />
          </label>
        )}
        <Seg
          items={[
            { key: "live", label: "实时登记" },
            { key: "archive", label: "存档快照" },
          ]}
          value={mode}
          onChange={(item) => { setMode(item); setSelected([]); setFilters((prev) => ({ ...prev, page: 1 })); }}
        />
        {canManage && <button className="btn" onClick={archive}>存档今日</button>}
        <button className="btn" onClick={refresh}>刷新</button>
        <button className="btn" onClick={() => download(
          mode === "archive" ? "/api/export/battery-archive.csv" : "/api/export/battery.csv",
          {
            ...(mode === "archive" ? { from: filters.from, to: filters.to } : { order_from: filters.from, order_to: filters.to }),
            q: filters.q, status: filters.status, page: filters.page, page_size: 50,
          },
        )}>导出 CSV</button>
      </PageHead>

      {main.data && (
        <KpiBand cols={4}>
          <Kpi
            label="当日已登记"
            value={num(mode === "live" ? todayRows.data?.rows.length ?? 0 : main.data.summary.qty)}
            unit="条"
            sub={
              (mode === "live" ? todayRows.data?.summary.amount : main.data.summary.amount) === null
                ? "金额 —"
                : `金额 ${num(((mode === "live" ? todayRows.data?.summary.amount : main.data.summary.amount) || 0) / 10000, 2)} 万元`
            }
          />
          <Kpi
            label="待登记候选"
            value={num(main.data.total)}
            unit="组"
            sub={`合计 ${num(main.data.summary.lines)} 行 / ${num((main.data.summary.amount || 0) / 10000, 2)} 万元`}
          />
          <Kpi
            label="已拣货"
            value={num(main.data.summary.picked)}
            unit="行"
            sub={main.data.summary.lines > 0 ? pct(main.data.summary.picked / main.data.summary.lines) : "—"}
          />
          <Kpi
            label="已复核"
            value={num(main.data.summary.checked)}
            unit="行"
            sub={main.data.summary.lines > 0 ? pct(main.data.summary.checked / main.data.summary.lines) : "—"}
          />
        </KpiBand>
      )}

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-head">
          <div className="panel-title">筛选</div>
          <div className="panel-sub">
            {mode === "archive"
              ? "存档快照（只读）"
              : main.data?.has_parts
                ? `备件编码表：${main.data.parts_count} 个`
                : "备件编码表未导入，暂按“动力电池总成”匹配"}
          </div>
        </div>
        <div className="panel-body">
          <div className="grid cols-4">
            <div className="field">
              <label>{mode === "archive" ? "登记日期从" : "订单日期从"}</label>
              <input className="input" type="date" value={draft.from}
                onChange={(event) => setDraft((prev) => ({ ...prev, from: event.target.value }))} />
            </div>
            <div className="field">
              <label>{mode === "archive" ? "登记日期到" : "订单日期到"}</label>
              <input className="input" type="date" value={draft.to}
                onChange={(event) => setDraft((prev) => ({ ...prev, to: event.target.value }))} />
            </div>
            <div className="field">
              <label>状态</label>
              <select className="select" value={draft.status}
                onChange={(event) => setDraft((prev) => ({ ...prev, status: event.target.value }))}>
                <option value="">全部</option>
                <option value="pending">待登记</option>
                <option value="confirmed">已登记</option>
              </select>
            </div>
            <div className="field">
              <label>关键字</label>
              <input className="input" placeholder="订单组号 / 经销商 / 备件编码 / 名称" value={draft.q}
                onChange={(event) => setDraft((prev) => ({ ...prev, q: event.target.value }))}
                onKeyDown={(event) => event.key === "Enter" && setFilters({ ...draft, page: 1 })} />
            </div>
          </div>
          <div className="toolbar">
            <button className="btn btn-primary" onClick={() => setFilters({ ...draft, page: 1 })}>查询</button>
            {canManage && mode === "live" && (
              <button className="btn btn-sm" onClick={() => void confirmItems(selected)}>登记所选</button>
            )}
            <span className="panel-sub">
              {main.data ? `本页 ${rows.length} 条 · ${num(main.data.total)} 条` : ""}
            </span>
          </div>
        </div>
      </div>

      {mode === "live" && (
        <Panel
          title="当天已登记明细（实际登记日期）"
          sub={todayRows.data ? `当天 ${todayRows.data.rows.length} 条` : undefined}
          flush
        >
          {todayRows.isLoading && <Loading />}
          {todayRows.data && (
            <div className="table-wrap" style={{ maxHeight: 320 }}>
              <table className="tbl" style={{ minWidth: 1650 }}>
                <thead>
                  <tr>
                    <th>订单日期</th><th>登记日期</th><th>订单组号</th><th>经销商</th><th>备件编码</th>
                    <th>备件名称</th><th className="num">行数</th><th className="num">数量</th>
                    <th className="num">金额</th><th className="num">拣货行数</th><th className="num">复核行数</th>
                    <th>库区</th><th>单据类型</th><th>是否免运费</th><th>区域</th><th>承运商</th>
                    <th>送达城市</th><th>地址</th>
                  </tr>
                </thead>
                <tbody>
                  {todayRows.data.rows.length === 0 && (
                    <tr>
                      <td colSpan={18} className="empty-cell"><Empty text="今天还没有已登记的动力电池明细" /></td>
                    </tr>
                  )}
                  {todayRows.data.rows.map((row, index) => (
                    <tr key={`${row.group_no}-${row.part_code}-${index}`} className={row.incomplete ? "danger-row" : ""}>
                      <td>{row.order_date || "-"}</td>
                      <td>{row.reg_date || "-"}</td>
                      <td>{row.group_no}</td>
                      <td>{row.dealer_short || row.dealer_full || "-"}</td>
                      <td><span className="mono">{row.part_code || "-"}</span></td>
                      <td>{row.part_name || "-"}</td>
                      <td className="num">{num(row.lines)}</td>
                      <td className="num">{num(row.qty)}</td>
                      <td className="num">{num(row.amount, 2)}</td>
                      <td className="num">{num(row.picked)}</td>
                      <td className="num">{num(row.checked)}</td>
                      <td>{row.zone || "-"}</td>
                      <td>{row.doc_type || "-"}</td>
                      <td>{row.freight_free || "-"}</td>
                      <td>{row.region || "-"}</td>
                      <td>{row.carrier || "-"}</td>
                      <td>{row.dest_city || "-"}</td>
                      <td className="small">{row.address || ""}</td>
                    </tr>
                  ))}
                </tbody>
                {todayRows.data.rows.length > 0 && (
                  <tfoot>
                    <tr>
                      <td><b>合计</b></td><td /><td /><td /><td /><td />
                      <td className="num"><b>{num(todayRows.data.summary.lines)}</b></td>
                      <td className="num"><b>{num(todayRows.data.summary.qty)}</b></td>
                      <td className="num"><b>{num(todayRows.data.summary.amount, 2)}</b></td>
                      <td className="num"><b>{num(todayRows.data.summary.picked)}</b></td>
                      <td className="num"><b>{num(todayRows.data.summary.checked)}</b></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </Panel>
      )}

      <Panel title="动力电池订单组" flush>
        {main.isLoading && <Loading />}
        {main.error && <Empty text={(main.error as Error).message} />}
        {main.data && (
          <>
            <div className="table-wrap" style={{ maxHeight: 560 }}>
              <table className="tbl" style={{ minWidth: 1800 }}>
                <thead>
                  <tr>
                    {mode === "live" ? (
                      <th>
                        <input type="checkbox" checked={allSelectable.length > 0 && selected.length === allSelectable.length}
                          onChange={(event) => setSelected(event.target.checked ? allSelectable : [])} />
                      </th>
                    ) : (
                      <th>存档日期</th>
                    )}
                    <th>状态</th><th>订单日期</th><th>登记日期</th><th>订单组号</th><th>经销商</th>
                    <th>备件编码</th><th>备件名称</th><th className="num">行数</th><th className="num">数量</th>
                    <th className="num">金额</th>
                    {mode === "archive" && <><th className="num">拣货行数</th><th className="num">复核行数</th></>}
                    <th>库区</th><th>单据类型</th><th>是否免运费</th><th>区域</th><th>承运商</th>
                    <th>送达城市</th><th>地址</th>
                    {mode === "live" && <th>操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={20} className="empty-cell"><Empty text={mode === "archive" ? "没有电池存档" : "没有动力电池候选"} /></td>
                    </tr>
                  )}
                  {rows.map((row, index) => {
                    const confirmed = Number(row.confirmed) === 1;
                    const checked = selected.some(
                      (item) => item.order_date === row.order_date && item.group_no === row.group_no && item.part_code === row.part_code,
                    );
                    return (
                      <tr key={`${row.group_no}-${row.part_code}-${index}`}>
                        {mode === "live" ? (
                          <td>
                            <input type="checkbox" disabled={confirmed} checked={checked}
                              onChange={(event) =>
                                setSelected(event.target.checked ? [...selected, row] : selected.filter(
                                  (item) => !(item.order_date === row.order_date && item.group_no === row.group_no && item.part_code === row.part_code),
                                ))
                              } />
                          </td>
                        ) : (
                          <td>{row.biz_date || "-"}</td>
                        )}
                        <td>{confirmed ? <Badge kind="ok">已登记</Badge> : <Badge kind="warn">待登记</Badge>}</td>
                        <td>{row.order_date || "-"}</td>
                        <td>{row.reg_date || "-"}</td>
                        <td>{row.group_no}</td>
                        <td title={row.dealer_full || ""}>{row.dealer_short || row.dealer_full || "-"}</td>
                        <td><span className="mono">{row.part_code || "-"}</span></td>
                        <td>{row.part_name || "-"}</td>
                        <td className="num">{num(row.lines)}</td>
                        <td className="num">{num(row.qty)}</td>
                        <td className="num">{row.amount === null ? "-" : num(row.amount, 2)}</td>
                        {mode === "archive" && (
                          <>
                            <td className="num">{num(row.picked)}</td>
                            <td className="num">{num(row.checked)}</td>
                          </>
                        )}
                        <td>{row.zone || "-"}</td>
                        <td>{row.doc_type || "-"}</td>
                        <td>{row.freight_free || "-"}</td>
                        <td>{row.region || "-"}</td>
                        <td>{row.carrier || "-"}</td>
                        <td className="ell" title={row.dest_city || ""}><span>{row.dest_city || "-"}</span></td>
                        <td className="small ell" title={row.address || ""}>
                          {row.address_matched ? <span>{row.address}</span> : <Badge kind="warn">未匹配地址</Badge>}
                        </td>
                        {mode === "live" && (
                          <td className="nowrap">
                            {canManage ? (
                              <>
                                <button className="btn btn-sm btn-ghost" onClick={() => {
                                  setAddressRow(row);
                                  setDealerForm(toDealerForm(row));
                                }}>
                                  {row.address_matched ? "修改地址/简称" : "录入地址"}
                                </button>
                                {confirmed ? (
                                  <button className="btn btn-sm btn-ghost" onClick={() => void unconfirm(row)}>取消登记</button>
                                ) : (
                                  <button className="btn btn-sm btn-primary" onClick={() => void confirmItems([row])}>登记</button>
                                )}
                              </>
                            ) : (
                              "-"
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
              <span>共 {num(main.data.total)} 条 · 第 {num(main.data.page)}/{num(main.data.pages)} 页</span>
              <button className="btn btn-sm" disabled={main.data.page <= 1}
                onClick={() => setFilters((prev) => ({ ...prev, page: prev.page - 1 }))}>上一页</button>
              <button className="btn btn-sm" disabled={main.data.page >= main.data.pages}
                onClick={() => setFilters((prev) => ({ ...prev, page: prev.page + 1 }))}>下一页</button>
            </div>
          </>
        )}
      </Panel>

      {addressRow && dealerForm && (
        <Modal
          title={`录入地址 · ${dealerForm.dealer_short || dealerForm.dealer_full}`}
          wide
          onClose={() => { setAddressRow(null); setDealerForm(null); }}
          footer={
            <>
              <button className="btn" onClick={() => { setAddressRow(null); setDealerForm(null); }}>取消</button>
              <button className="btn btn-primary" onClick={saveDealer}>保存</button>
            </>
          }
        >
          <div className="grid cols-2">
            {([
              ["dealer_full", "经销商全称", true],
              ["dealer_short", "经销商简称", false],
              ["zone", "库区", false],
              ["doc_type", "单据类型", false],
              ["freight_free", "是否免运费", false],
              ["region", "区域", false],
              ["carrier", "承运商", false],
              ["dest_city", "送达城市", false],
            ] as const).map(([key, label, readonly]) => (
              <div className="field" key={key}>
                <label>{label}</label>
                <input className="input" readOnly={readonly} value={dealerForm[key]}
                  onChange={(event) => setDealerForm({ ...dealerForm, [key]: event.target.value })} />
              </div>
            ))}
          </div>
          <div className="field">
            <label>地址</label>
            <textarea className="input" rows={3} value={dealerForm.address}
              onChange={(event) => setDealerForm({ ...dealerForm, address: event.target.value })} />
          </div>
        </Modal>
      )}
    </>
  );
}
