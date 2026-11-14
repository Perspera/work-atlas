import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { api } from "../lib/api";
import { num } from "../lib/format";
import { useBizDate } from "../lib/hooks";
import { hasPerm, useApp } from "../lib/store";
import { Empty, Loading, Modal, PageHead, Panel, Seg } from "../components/ui";
import { WidgetGrid, usePageLayout } from "../features/dashboard";

interface LaborRow {
  person: string;
  pick_rows: number;
  pick_hours: number;
  pick_rate: number | null;
  pick_adjusted: number | null;
  check_rows: number;
  check_hours: number;
  check_rate: number | null;
  check_adjusted: number | null;
  rows: number;
}

interface LaborData {
  date: string;
  rows: LaborRow[];
  totals: {
    people: number;
    rows: number;
    pick_rows: number;
    check_rows: number;
    pick_hours: number;
    check_hours: number;
    pick_rate: number | null;
    check_rate: number | null;
  };
  adjustments: Record<string, { hours: number | null }>;
  archived: boolean;
  archived_at: string | null;
  archived_rows: number;
  can_adjust: boolean;
  can_archive: boolean;
  can_settings: boolean;
  gap_minutes: number;
  break_count: number;
}

interface BreakRow {
  start: string;
  end: string;
  enabled: boolean;
  note: string;
}

interface SettingsData {
  gap_minutes: number;
  breaks: BreakRow[];
  can_edit: boolean;
}

function SettingsDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useApp((state) => state.toast);
  const [gap, setGap] = useState("");
  const [rows, setRows] = useState<BreakRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useQuery({
    queryKey: ["labor-settings"],
    queryFn: async () => {
      const data = await api<SettingsData>("/api/labor/settings");
      if (!data.can_edit) throw new Error("没有修改作业设置的权限");
      setGap(String(data.gap_minutes || 30));
      setRows(data.breaks || []);
      setLoaded(true);
      return data;
    },
    retry: false,
  });

  const save = async () => {
    setBusy(true);
    try {
      await api("/api/labor/settings", {
        method: "PUT",
        body: { gap_minutes: Number(gap), breaks: rows },
      });
      toast("作业设置已保存", "ok");
      onSaved();
    } catch (error) {
      toast((error as Error).message, "err");
      setBusy(false);
    }
  };

  const rearchive = async () => {
    if (!window.confirm("按新口径重新存档全部日期？会覆盖历史人效存档（留审计）。")) return;
    setBusy(true);
    try {
      const result = await api<{ dates: string[] }>("/api/labor/rearchive", { method: "POST" });
      toast(`已重算 ${result.dates.length} 个日期`, "ok");
      setBusy(false);
    } catch (error) {
      toast((error as Error).message, "err");
      setBusy(false);
    }
  };

  return (
    <Modal
      title="作业设置 · 人效工时口径"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy || !loaded} onClick={save}>保存并生效</button>
        </>
      }
    >
      <div className="field">
        <label>相邻作业间隔阈值（分钟）</label>
        <input className="input" type="number" min={1} max={240} value={gap}
          onChange={(event) => setGap(event.target.value)} />
        <div className="small muted">两次作业间隔 ≤ 阈值才计入工时；超过视为休息不计。默认 30 分钟。</div>
      </div>
      <div className="field">
        <label>休息时段（每天适用，可多条）</label>
        {rows.length === 0 && <div className="small muted">还没有休息时段</div>}
        {rows.map((row, index) => (
          <div key={index} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
            <input className="input" style={{ width: 80 }} placeholder="12:00" value={row.start}
              onChange={(event) => setRows(rows.map((item, i) => (i === index ? { ...item, start: event.target.value } : item)))} />
            <span>—</span>
            <input className="input" style={{ width: 80 }} placeholder="13:00" value={row.end}
              onChange={(event) => setRows(rows.map((item, i) => (i === index ? { ...item, end: event.target.value } : item)))} />
            <label className="small">
              <input type="checkbox" checked={row.enabled}
                onChange={(event) => setRows(rows.map((item, i) => (i === index ? { ...item, enabled: event.target.checked } : item)))} /> 启用
            </label>
            <input className="input" style={{ flex: 1 }} placeholder="备注（如 午休）" value={row.note}
              onChange={(event) => setRows(rows.map((item, i) => (i === index ? { ...item, note: event.target.value } : item)))} />
            <button className="btn btn-sm btn-danger" onClick={() => setRows(rows.filter((_, i) => i !== index))}>
              删除
            </button>
          </div>
        ))}
        <button className="btn btn-sm" onClick={() => setRows([...rows, { start: "", end: "", enabled: true, note: "" }])}>
          + 添加休息时段
        </button>
      </div>
      <div className="field">
        <label>历史归档</label>
        <button className="btn btn-sm" disabled={busy} onClick={rearchive}>按新口径重新存档全部日期</button>
        <div className="small muted" style={{ marginTop: 4 }}>
          已经存档的日期不会自动重算，点这里覆盖（会写审计）。
        </div>
      </div>
    </Modal>
  );
}

function AdjustCell({ row, date, onSaved }: { row: LaborRow; date: string; onSaved: () => void }) {
  const toast = useApp((state) => state.toast);
  const [pick, setPick] = useState(row.pick_adjusted === null ? "" : String(row.pick_adjusted));
  const [check, setCheck] = useState(row.check_adjusted === null ? "" : String(row.check_adjusted));

  const put = async (role: string, value: string) => {
    await api("/api/labor/adjust", {
      method: "PUT",
      body: { date, person: row.person, role, hours: value.trim() === "" ? null : Number(value) },
    });
  };

  const save = async () => {
    try {
      await Promise.all([put("pick", pick), put("check", check)]);
      toast(`已保存 ${row.person} 的工时`, "ok");
      onSaved();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  const clear = async () => {
    try {
      await Promise.all([put("pick", ""), put("check", "")]);
      toast("已恢复自动工时", "ok");
      onSaved();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  return (
    <td className="nowrap">
      <input className="input" style={{ width: 64, height: 24 }} value={pick} placeholder={num(row.pick_hours, 2)}
        onChange={(event) => setPick(event.target.value)} />{" "}
      <input className="input" style={{ width: 64, height: 24 }} value={check} placeholder={num(row.check_hours, 2)}
        onChange={(event) => setCheck(event.target.value)} />{" "}
      <button className="btn btn-sm btn-primary" onClick={save}>保存</button>{" "}
      <button className="btn btn-sm btn-ghost" onClick={clear}>恢复自动</button>
    </td>
  );
}

export default function LaborPage() {
  const date = useBizDate();
  const me = useApp((state) => state.me);
  const toast = useApp((state) => state.toast);
  const navigate = useNavigate();
  const [mode, setMode] = useState<"live" | "archive">("live");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const layout = usePageLayout("labor");
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["labor", date, mode],
    queryFn: () => api<LaborData>("/api/labor", { query: { date, mode } }),
    enabled: Boolean(date),
  });

  const canAdjust = hasPerm(me, "action.labor.adjust") && data?.can_adjust;
  // 旧版 web/app.js:1388/1399 只看权限位决定是否显示，不等数据加载。
  const canArchive = hasPerm(me, "action.labor.archive");
  const canSettings = hasPerm(me, "action.labor.settings");

  const archive = async () => {
    const force = Boolean(data?.archived);
    if (!window.confirm(force ? `会用当前数据覆盖 ${date} 的人效存档（留审计）。确定？` : `把 ${date} 的人工作业量按作业日期存档。确定？`)) {
      return;
    }
    try {
      const result = await api<{ count: number }>("/api/labor/archive", { method: "POST", body: { date, force } });
      toast(`已存档 ${result.count} 条人效记录`, "ok");
      setMode("archive");
      refetch();
    } catch (err) {
      toast((err as Error).message, "err");
    }
  };

  const totals = data?.totals;

  return (
    <>
      <PageHead
        title="人工作业量"
        sub={`按作业日期统计 ${data?.date || date} · 拣货/复核分开计数；人效 = 行数 ÷ 有效作业工时（自动扣除休息时段）`}
      >
        <Seg
          items={[
            { key: "live", label: "实时" },
            { key: "archive", label: "存档" },
          ]}
          value={mode}
          onChange={setMode}
        />
        {canArchive && <button className="btn" onClick={archive}>存档本日</button>}
        {canSettings && <button className="btn" onClick={() => setSettingsOpen(true)}>作业设置</button>}
        {hasPerm(me, "action.dashboard.edit") && (
          <button className="btn" onClick={() => navigate("/board/page/labor")}>编辑布局</button>
        )}
        <button className="btn" onClick={() => refetch()}>刷新</button>
      </PageHead>

      {totals && (
        <div className="small muted" style={{ marginBottom: 12 }}>
          作业日期 <b>{data?.date}</b> · 拣货 {num(totals.pick_hours, 2)}h / 复核 {num(totals.check_hours, 2)}h
          {" · "}间隔阈值 {data?.gap_minutes || 30} 分 · 休息 {data?.break_count || 0} 段
          {mode === "archive" &&
            (data?.archived_at
              ? ` · 已存档 ${data.archived_at}（${data.archived_rows} 条）`
              : " · 该作业日期还没有存档")}
        </div>
      )}

      {layout.data && layout.data.layout.widgets.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <WidgetGrid layout={layout.data.layout} date={date} mode={mode} />
        </div>
      )}

      <Panel
        title="人员明细与工时校正"
        sub="工时默认 = 该工种当天有作业的小时数；可手工改成实际工时"
        flush
      >
        {isLoading && <Loading />}
        {error && <Empty text={(error as Error).message} />}
        {data && data.rows.length === 0 && (
          <Empty
            text={
              mode === "archive"
                ? "该作业日期还没有人效存档"
                : "该作业日期没有人员作业数据（人员字段从 2026-11-03 起采集）"
            }
          />
        )}
        {data && data.rows.length > 0 && (
          <div className="table-wrap" style={{ maxHeight: 460 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>人员</th>
                  <th className="num">拣货行</th>
                  <th className="num">拣货小时</th>
                  <th className="num">拣货人效</th>
                  <th className="num">复核行</th>
                  <th className="num">复核小时</th>
                  <th className="num">复核人效</th>
                  {mode === "live" && canAdjust && <th>校正（拣货/复核 小时）</th>}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const adjusted = row.pick_adjusted !== null || row.check_adjusted !== null;
                  return (
                    <tr key={row.person}>
                      <td>
                        {row.person}
                        {adjusted && <> <span className="badge warn">已校正</span></>}
                      </td>
                      <td className="num">{row.pick_rows}</td>
                      <td className="num">{num(row.pick_hours, 2)}</td>
                      <td className="num">{row.pick_rate === null ? "-" : num(row.pick_rate, 1)}</td>
                      <td className="num">{row.check_rows}</td>
                      <td className="num">{num(row.check_hours, 2)}</td>
                      <td className="num">{row.check_rate === null ? "-" : num(row.check_rate, 1)}</td>
                      {mode === "live" && canAdjust && (
                        <AdjustCell row={row} date={date} onSaved={() => void refetch()} />
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            void refetch();
          }}
        />
      )}
    </>
  );
}
