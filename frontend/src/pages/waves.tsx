import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { api } from "../lib/api";
import { num, pct } from "../lib/format";
import { useBizDate } from "../lib/hooks";
import { hasPerm, useApp } from "../lib/store";
import { Badge, Empty, Loading, Modal, PageHead, Panel } from "../components/ui";

interface WaveRow {
  id: number;
  wave_no: string;
  note: string | null;
  carrier_override: string | null;
  updated_at: string;
  groups: number;
  lines: number;
  amount: number | null;
  rate: number;
  done: boolean;
  pending: boolean;
  excluded_all: boolean;
  tms_carrier: string | null;
}

interface CandidateRow {
  wave_no: string;
  groups: number;
  lines: number;
  amount: number | null;
  order_date: string;
  wave_time: string;
}

function Progress({ rate }: { rate: number }) {
  const color = rate >= 0.999 ? "#0b8a63" : rate >= 0.6 ? "#1d5fbf" : "#b45309";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, minWidth: 60, height: 6, background: "#eef1f6", borderRadius: 4 }}>
        <div style={{ width: `${Math.min(100, rate * 100)}%`, height: "100%", borderRadius: 4, background: color }} />
      </div>
      <span className="small muted">{pct(rate)}</span>
    </div>
  );
}

export default function WavesPage() {
  const date = useBizDate();
  const me = useApp((state) => state.me);
  const toast = useApp((state) => state.toast);
  const navigate = useNavigate();
  const canCreate = hasPerm(me, "action.waves.create");
  const canUpdate = hasPerm(me, "action.waves.update");
  const canDelete = hasPerm(me, "action.waves.delete");

  const [addOpen, setAddOpen] = useState(false);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<WaveRow | null>(null);
  const [editNote, setEditNote] = useState("");
  const [editCarrier, setEditCarrier] = useState("");
  const [showCandidates, setShowCandidates] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const waves = useQuery({
    queryKey: ["waves", date],
    queryFn: () => api<{ rows: WaveRow[] }>("/api/waves", { query: { date } }),
    enabled: Boolean(date),
  });

  const candidates = useQuery({
    queryKey: ["wave-candidates", date],
    queryFn: () => api<{ rows: CandidateRow[] }>("/api/waves/candidates", { query: { date } }),
    enabled: Boolean(date) && showCandidates,
  });

  const register = async (payload: string | string[]) => {
    try {
      const result = await api<{ added: string[]; skipped: { wave_no: string; reason: string }[]; pending: string[] }>(
        "/api/waves",
        { method: "POST", body: { date, waves: payload } },
      );
      let message = `已登记 ${result.added.length} 个波次`;
      if (result.pending.length) message += `（其中 ${result.pending.length} 个待数据）`;
      if (result.skipped.length) message += `，跳过 ${result.skipped.length} 个`;
      toast(message, "ok");
      setAddOpen(false);
      setText("");
      setSelected([]);
      void waves.refetch();
      void candidates.refetch();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  const remove = async (row: WaveRow) => {
    if (!window.confirm("删除后该波次不再计入当天单量与进度（可在审计里追溯）。确定删除？")) return;
    try {
      await api(`/api/waves/${row.id}`, { method: "DELETE" });
      toast("已删除", "ok");
      void waves.refetch();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      await api(`/api/waves/${editing.id}`, {
        method: "PUT",
        body: {
          note: editNote.trim(),
          carrier_override: editCarrier.trim(),
          expected_updated_at: editing.updated_at,
        },
      });
      toast("已保存", "ok");
      setEditing(null);
      void waves.refetch();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  return (
    <>
      <PageHead
        title="波次登记"
        sub={`业务日期 ${date} · 当天要发运的波次在这里登记，系统自动带出订单组、行数、金额与进度`}
      >
        {canCreate && <button className="btn btn-primary" onClick={() => setAddOpen(true)}>新增波次</button>}
        <button className="btn" onClick={() => void waves.refetch()}>刷新</button>
      </PageHead>

      {canCreate && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-head">
            <button className="btn btn-sm" onClick={() => setShowCandidates((open) => !open)}>
              {showCandidates ? "收起候选波次" : "显示候选波次"}
            </button>
            <div className="panel-sub">
              {showCandidates && candidates.data ? `候选 ${candidates.data.rows.length} 个` : ""}
            </div>
          </div>
          {showCandidates && (
            <div className="panel-body flush">
              {candidates.isLoading && <Loading text="加载候选波次" />}
              {candidates.data && candidates.data.rows.length === 0 && <Empty text="没有未登记的波次" />}
              {candidates.data && candidates.data.rows.length > 0 && (
                <>
                  <div className="table-wrap" style={{ maxHeight: 320 }}>
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th style={{ width: 40 }} />
                          <th>波次号</th>
                          <th className="num">订单组</th>
                          <th className="num">行数</th>
                          <th className="num">金额(万)</th>
                          <th>订单日期</th>
                          <th>波次时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {candidates.data.rows.map((row) => (
                          <tr key={row.wave_no}>
                            <td>
                              <input
                                type="checkbox"
                                checked={selected.includes(row.wave_no)}
                                onChange={(event) =>
                                  setSelected(
                                    event.target.checked
                                      ? [...selected, row.wave_no]
                                      : selected.filter((item) => item !== row.wave_no),
                                  )
                                }
                              />
                            </td>
                            <td>{row.wave_no}</td>
                            <td className="num">{row.groups}</td>
                            <td className="num">{row.lines}</td>
                            <td className="num">{row.amount === null ? "-" : num(row.amount, 2)}</td>
                            <td>{row.order_date || ""}</td>
                            <td>{row.wave_time || ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="pager">
                    <button className="btn btn-sm" disabled={selected.length === 0} onClick={() => void register(selected)}>
                      登记所选（{selected.length}）
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      <Panel
        title="已登记波次"
        sub={
          waves.data
            ? `共 ${waves.data.rows.length} 个波次（待数据 ${waves.data.rows.filter((row) => row.pending).length} 个）· ${num(
                waves.data.rows.reduce((sum, row) => sum + row.lines, 0),
              )} 行`
            : undefined
        }
        flush
      >
        {waves.isLoading && <Loading />}
        {waves.error && <Empty text={(waves.error as Error).message} />}
        {waves.data && (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>波次号</th>
                  <th className="num">订单组</th>
                  <th className="num">行数</th>
                  <th className="num">金额(万)</th>
                  <th>出库进度</th>
                  <th>运输承运商</th>
                  <th>备注</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {waves.data.rows.length === 0 && (
                  <tr>
                    <td colSpan={8}><Empty text="当天还没有登记波次" /></td>
                  </tr>
                )}
                {waves.data.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.wave_no}
                      {row.pending && <> <Badge kind="warn">待数据</Badge></>}
                      {row.excluded_all && <> <Badge>已全部移出</Badge></>}
                    </td>
                    <td className="num">{row.groups}</td>
                    <td className="num">{row.lines}</td>
                    <td className="num">{row.amount === null ? "-" : num(row.amount, 2)}</td>
                    <td><Progress rate={row.rate} /></td>
                    <td>{row.tms_carrier || (row.pending ? "-" : "未匹配")}</td>
                    <td className="small muted">{row.note || ""}</td>
                    <td className="nowrap">
                      <button className="btn btn-sm btn-ghost" onClick={() => navigate(`/orders?wave=${encodeURIComponent(row.wave_no)}`)}>
                        订单组
                      </button>
                      {canUpdate && (
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => {
                            setEditing(row);
                            setEditNote(row.note || "");
                            setEditCarrier(row.carrier_override || "");
                          }}
                        >
                          编辑
                        </button>
                      )}
                      {canDelete && (
                        <button className="btn btn-sm btn-danger" onClick={() => void remove(row)}>删除</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {addOpen && (
        <Modal
          title={`新增波次登记 · ${date}`}
          onClose={() => setAddOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setAddOpen(false)}>取消</button>
              <button className="btn btn-primary" disabled={!text.trim()} onClick={() => void register(text)}>
                登记
              </button>
            </>
          }
        >
          <div className="field">
            <label>波次号（可多条：换行、逗号或空格分隔）</label>
            <textarea className="input" rows={5} placeholder={"WAVE1090522088\nWAVE1090522090"}
              value={text} onChange={(event) => setText(event.target.value)} />
          </div>
          <div className="small muted">将登记到业务日 {date}。也可以先「显示候选波次」勾选后一键登记。</div>
        </Modal>
      )}

      {editing && (
        <Modal
          title={`编辑波次 ${editing.wave_no}`}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button className="btn" onClick={() => setEditing(null)}>取消</button>
              <button className="btn btn-primary" onClick={saveEdit}>保存</button>
            </>
          }
        >
          <div className="field">
            <label>备注</label>
            <input className="input" value={editNote} onChange={(event) => setEditNote(event.target.value)} />
          </div>
          <div className="field">
            <label>指派承运商（覆盖线路映射，留空则按经销商映射）</label>
            <input className="input" placeholder="如：民生物流 / 顺丰速运" value={editCarrier}
              onChange={(event) => setEditCarrier(event.target.value)} />
          </div>
        </Modal>
      )}
    </>
  );
}
