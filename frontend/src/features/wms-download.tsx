import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { num } from "../lib/format";
import { queryClient } from "../lib/query";
import { hasPerm, useApp } from "../lib/store";
import { Empty, Loading, Modal, Panel } from "../components/ui";

interface WmsSchedule {
  mode?: string;
  intervalMinutes?: number;
  startTime?: string;
  endTime?: string;
  times?: string[];
}

interface WmsConfig {
  url?: string;
  dateMode?: string;
  fixedDate?: string;
  relativeDays?: number;
  deliverDir?: string;
  loginMode?: string;
  schedule?: WmsSchedule;
}

interface WmsTask {
  installed?: boolean;
  enabled?: boolean;
  nextRun?: string | null;
  needs_reinstall?: boolean;
  lastResult?: string | number | null;
}

interface WmsLastRun {
  running?: boolean;
  exitCode?: number | null;
  startedAt?: string;
}

interface WmsState {
  config: WmsConfig;
  task: WmsTask;
  lastRun: WmsLastRun;
  lastSummary?: string | null;
  latest?: { file?: { name?: string; rows?: number; imported_at?: string } } | null;
  logs?: { run?: string } | null;
}

const DATE_MODES: [string, string][] = [
  ["today", "今天"],
  ["yesterday", "昨天"],
  ["fixed", "固定日期"],
  ["relative", "相对今天"],
];

function statusText(data: WmsState): string {
  const task = data.task || {};
  const last = data.lastRun || {};
  const parts: string[] = [];
  parts.push(task.installed ? (task.enabled ? "定时：已启用" : "定时：已暂停") : "定时：未安装");
  if (task.nextRun) parts.push("下次 " + task.nextRun);
  if (last.running) parts.push("当前运行中");
  else if (last.exitCode === 0) parts.push("最近：成功");
  else if (last.exitCode !== undefined && last.exitCode !== null) parts.push("最近：失败");
  else parts.push("最近：暂无运行");
  if (task.lastResult !== undefined && task.lastResult !== null) parts.push("任务结果 " + task.lastResult);
  if (task.needs_reinstall) parts.push("启动器缺失，请重新应用定时任务");
  if (data.latest && data.latest.file) parts.push("最近文件 " + (data.latest.file.imported_at || ""));
  return parts.join(" · ");
}

interface WmsForm {
  url: string;
  deliverDir: string;
  dateMode: string;
  fixedDate: string;
  relativeDays: string;
  scheduleMode: string;
  times: string;
  intervalMinutes: string;
  startTime: string;
  endTime: string;
}

function toForm(cfg: WmsConfig): WmsForm {
  const schedule = cfg.schedule || {};
  return {
    url: cfg.url || "",
    deliverDir: cfg.deliverDir || "",
    dateMode: cfg.dateMode || "today",
    fixedDate: cfg.fixedDate || "",
    relativeDays: String(cfg.relativeDays ?? 0),
    scheduleMode: schedule.mode === "daily" ? "daily" : "interval",
    times: (schedule.times && schedule.times.length ? schedule.times : ["08:30"]).join(","),
    intervalMinutes: String(schedule.intervalMinutes ?? 10),
    startTime: schedule.startTime || "08:00",
    endTime: schedule.endTime || "21:00",
  };
}

function collect(form: WmsForm) {
  return {
    url: form.url.trim(),
    dateMode: form.dateMode,
    fixedDate: form.fixedDate,
    relativeDays: Number(form.relativeDays) || 0,
    deliverDir: form.deliverDir.trim(),
    schedule: {
      mode: form.scheduleMode,
      intervalMinutes: Number(form.intervalMinutes) || 10,
      startTime: form.startTime || "08:00",
      endTime: form.endTime || "21:00",
      times: (form.times || "08:30").split(",").map((item) => item.trim()).filter(Boolean),
    },
  };
}

export default function WmsPanel() {
  const me = useApp((state) => state.me);
  const toast = useApp((state) => state.toast);
  const canScan = hasPerm(me, "action.scan");

  const state = useQuery({
    queryKey: ["wms-state"],
    queryFn: () => api<WmsState>("/api/wms-download", { query: { tail: 120 } }),
  });

  const [form, setForm] = useState<WmsForm | null>(null);
  const inited = useRef(false);
  useEffect(() => {
    if (state.data && !inited.current) {
      inited.current = true;
      setForm(toForm(state.data.config || {}));
    }
  }, [state.data]);

  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");
  const [logsOpen, setLogsOpen] = useState(false);

  const logs = useQuery({
    queryKey: ["wms-logs"],
    queryFn: () => api<{ run: string }>("/api/wms-download/log", { query: { tail: 200 } }),
    enabled: logsOpen,
  });

  const setField = (patch: Partial<WmsForm>) =>
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));

  const saveConfig = async (silent: boolean) => {
    if (!form) return;
    await api<WmsState>("/api/wms-download/config", { method: "PUT", body: collect(form) });
    if (!silent) toast("WMS 配置已保存", "ok");
    void state.refetch();
  };

  const onSave = async () => {
    setBusy(true);
    try {
      await saveConfig(false);
    } catch (error) {
      toast((error as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  const applySchedule = async (action: "install" | "disable" | "remove") => {
    setBusy(true);
    try {
      if (action === "install") await saveConfig(true);
      await api<{ state?: WmsState }>("/api/wms-download/schedule", { method: "POST", body: { action } });
      toast(
        action === "install" ? "定时任务已启用" : action === "disable" ? "定时任务已暂停" : "定时任务已移除",
        "ok",
      );
      void state.refetch();
    } catch (error) {
      toast((error as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    if (!window.confirm("确定删除 WMS 定时任务？配置和已下载文件不受影响。")) return;
    await applySchedule("remove");
  };

  const runDownload = async () => {
    if (!form) return;
    setBusy(true);
    setHint("正在下载，请稍候…");
    try {
      await saveConfig(true);
      await api("/api/wms-download/run", { method: "POST", body: { date: "" } });
      const deadline = Date.now() + 180000;
      let status: WmsLastRun | null = null;
      while (Date.now() < deadline) {
        await new Promise<void>((resolve) => window.setTimeout(() => resolve(), 2500));
        const run = await api<{ run: WmsLastRun }>("/api/wms-download/run");
        status = run.run || {};
        if (!status.running) break;
        const started = Date.parse(status.startedAt || new Date().toISOString());
        setHint(`正在下载（${Math.round((Date.now() - started) / 1000)}s）…`);
      }
      if (status && status.running) {
        setHint("仍在运行，请稍后在日志查看");
        toast("下载仍在运行", "warn");
      } else if (status && status.exitCode === 0) {
        setHint("已完成，正在扫描导入…");
        await api("/api/scan", { method: "POST" }).catch(() => {});
        void queryClient.invalidateQueries();
        toast("WMS 下载完成", "ok");
        void state.refetch();
      } else {
        setHint("失败，请查看日志");
        toast("WMS 下载失败，请查看日志", "err");
        void state.refetch();
      }
    } catch (error) {
      setHint("");
      toast((error as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  const data = state.data;
  const cfg = data?.config || {};
  const task = data?.task || {};
  const latestFile = data?.latest?.file;
  const lastText = (data?.lastSummary || "").replace(/^\[[^\]]+\]\s*/, "");
  const enabled = task.enabled;

  return (
    <>
      <Panel
        title="WMS 自动下载"
        sub={data ? statusText(data) : "加载中…"}
        actions={canScan ? undefined : <span className="small muted">只读（缺少扫描权限）</span>}
      >
        {state.isLoading && <Loading text="加载 WMS 状态" />}
        {state.error && <Empty text={(state.error as Error).message} />}
        {data && form && (
          <>
            <div className="small muted" style={{ marginBottom: 10 }}>
              登录方式：{cfg.loginMode || "aTrust SSO / 复用已登录会话"}
              {" · "}
              {latestFile
                ? `最近导入：${latestFile.name || ""} · ${num(latestFile.rows)} 行 · ${latestFile.imported_at || ""}`
                : "还没有导入过出库文件"}
              {lastText ? ` · 最近日志：${lastText.slice(0, 120)}` : ""}
            </div>
            <div className="grid cols-2">
              <div className="field">
                <label>WMS 地址</label>
                <input className="input" value={form.url} disabled={!canScan}
                  onChange={(event) => setField({ url: event.target.value })} />
              </div>
              <div className="field">
                <label>下载目录</label>
                <input className="input" value={form.deliverDir} disabled={!canScan}
                  onChange={(event) => setField({ deliverDir: event.target.value })} />
              </div>
            </div>
            <div className="grid cols-3">
              <div className="field">
                <label>查询日期</label>
                <select className="select" value={form.dateMode} disabled={!canScan}
                  onChange={(event) => setField({ dateMode: event.target.value })}>
                  {DATE_MODES.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ display: form.dateMode === "fixed" ? "flex" : "none" }}>
                <label>固定日期</label>
                <input className="input" type="date" value={form.fixedDate} disabled={!canScan}
                  onChange={(event) => setField({ fixedDate: event.target.value })} />
              </div>
              <div className="field" style={{ display: form.dateMode === "relative" ? "flex" : "none" }}>
                <label>相对今天（天）</label>
                <input className="input" type="number" min={-365} max={365} value={form.relativeDays}
                  disabled={!canScan} onChange={(event) => setField({ relativeDays: event.target.value })} />
              </div>
            </div>
            <div className="grid cols-2">
              <div className="field">
                <label>执行方式</label>
                <select className="select" value={form.scheduleMode} disabled={!canScan}
                  onChange={(event) => setField({ scheduleMode: event.target.value })}>
                  <option value="interval">间隔执行</option>
                  <option value="daily">每天固定时间</option>
                </select>
              </div>
              <div className="field" style={{ display: form.scheduleMode === "daily" ? "flex" : "none" }}>
                <label>每天时间点（逗号分隔）</label>
                <input className="input" value={form.times} disabled={!canScan}
                  onChange={(event) => setField({ times: event.target.value })} />
              </div>
            </div>
            <div className="grid cols-3" style={{ display: form.scheduleMode === "interval" ? undefined : "none" }}>
              <div className="field">
                <label>间隔分钟</label>
                <input className="input" type="number" min={1} max={1440} value={form.intervalMinutes}
                  disabled={!canScan} onChange={(event) => setField({ intervalMinutes: event.target.value })} />
              </div>
              <div className="field">
                <label>开始时间</label>
                <input className="input" type="time" value={form.startTime} disabled={!canScan}
                  onChange={(event) => setField({ startTime: event.target.value })} />
              </div>
              <div className="field">
                <label>结束时间</label>
                <input className="input" type="time" value={form.endTime} disabled={!canScan}
                  onChange={(event) => setField({ endTime: event.target.value })} />
              </div>
            </div>
            <div className="toolbar" style={{ marginTop: 2 }}>
              <button className="btn btn-primary" disabled={!canScan || busy} onClick={() => void onSave()}>
                保存配置
              </button>
              <button className="btn" disabled={!canScan || busy} onClick={() => void runDownload()}>
                立即下载
              </button>
              <button className="btn" disabled={!canScan || busy} onClick={() => void applySchedule("install")}>
                {enabled ? "更新定时任务" : "启用定时任务"}
              </button>
              <button className="btn" disabled={!canScan || !task.installed || busy}
                onClick={() => void applySchedule("disable")}>
                暂停
              </button>
              <button className="btn btn-ghost" disabled={!canScan || !task.installed || busy}
                onClick={() => void onRemove()}>
                移除任务
              </button>
              <button className="btn btn-ghost" onClick={() => setLogsOpen(true)}>查看日志</button>
              <span className="small muted">{hint}</span>
            </div>
          </>
        )}
      </Panel>

      {logsOpen && (
        <Modal
          title="WMS 下载日志"
          wide
          onClose={() => setLogsOpen(false)}
          footer={<button className="btn btn-sm" onClick={() => void logs.refetch()}>刷新</button>}
        >
          <div className="small muted" style={{ marginBottom: 6 }}>最近运行日志（尾部 200 行）</div>
          {logs.isLoading && <Loading text="加载日志" />}
          {logs.error && <Empty text={(logs.error as Error).message} />}
          {logs.data && <pre className="wms-log">{logs.data.run || "（暂无）"}</pre>}
        </Modal>
      )}
    </>
  );
}
