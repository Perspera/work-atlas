import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { pct } from "../lib/format";
import { useBizDate } from "../lib/hooks";
import { useApp } from "../lib/store";
import { Badge, Empty, Loading, Modal, PageHead, Panel } from "../components/ui";
import { KpiCard } from "../components/charts";

interface AlertRow {
  id: number;
  level: string;
  route?: string;
  title: string;
  body?: string;
  read_at?: string | null;
  created_at?: string;
}

interface Owner {
  id: number;
  username: string;
  display_name: string;
}

interface RouteRow {
  route: string;
  deadline: string;
  enabled: number;
  owners: Owner[];
  lines: number;
  checked: number;
  rate: number | null;
  state: string;
}

interface RoutesData {
  rows: RouteRow[];
  users: Owner[];
  can_manage: boolean;
  lead_minutes: number;
  repeat_minutes: number;
  unread: number;
}

const STATE_TEXT: Record<string, { label: string; kind: string }> = {
  overdue: { label: "已超时", kind: "danger" },
  due_soon: { label: "临近", kind: "warn" },
  done: { label: "已完成", kind: "ok" },
  running: { label: "进行中", kind: "" },
  disabled: { label: "已停用", kind: "" },
  closed: { label: "非当日", kind: "" },
  no_data: { label: "无数据", kind: "" },
};

export default function AlertsPage() {
  const date = useBizDate();
  const toast = useApp((state) => state.toast);
  const [editing, setEditing] = useState<{ route: RouteRow; users: Owner[] } | null>(null);
  const [deadline, setDeadline] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [owners, setOwners] = useState<number[]>([]);

  const messages = useQuery({
    queryKey: ["alerts", "list", date],
    queryFn: () => api<{ rows: AlertRow[]; unread: number }>("/api/alerts", { query: { limit: 100 } }),
    enabled: Boolean(date),
  });

  const routes = useQuery({
    queryKey: ["alert-routes", date],
    queryFn: () => api<RoutesData>("/api/alerts/routes", { query: { date } }),
    enabled: Boolean(date),
  });

  const refresh = () => {
    void messages.refetch();
    void routes.refetch();
  };

  const markAll = async () => {
    try {
      await api("/api/alerts/read", { method: "POST", body: { all: true } });
      refresh();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  const openEditor = (row: RouteRow, users: Owner[]) => {
    setEditing({ route: row, users });
    setDeadline(row.deadline || "17:00");
    setEnabled(Boolean(row.enabled));
    setOwners((row.owners || []).map((owner) => owner.id));
  };

  const saveRoute = async () => {
    if (!editing) return;
    try {
      await api("/api/alerts/routes", {
        method: "PUT",
        body: { route: editing.route.route, deadline, enabled, owners },
      });
      toast(`已保存 ${editing.route.route}`, "ok");
      setEditing(null);
      void routes.refetch();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  const routeRows = routes.data?.rows || [];
  const overdue = routeRows.filter((row) => row.state === "overdue").length;
  const soon = routeRows.filter((row) => row.state === "due_soon").length;

  return (
    <>
      <PageHead
        title="预警中心"
        sub="按线路设截止时间；临近/超时自动提醒线路负责人（复核完成率 100% 视为完成）"
      >
        <button className="btn" onClick={markAll}>全部已读</button>
        <button className="btn" onClick={refresh}>刷新</button>
      </PageHead>

      <div className="kpi-row" style={{ marginBottom: 14 }}>
        <KpiCard label="未读消息" value={routes.data?.unread ?? messages.data?.unread ?? 0} unit="条" sub="点右上铃铛查看明细" />
        <KpiCard label="超时线路" value={overdue} unit="条" sub="已完成复核的不计入" />
        <KpiCard label="临近截止" value={soon} unit="条" sub={`距截止 ≤ ${routes.data?.lead_minutes ?? 30} 分钟`} />
      </div>

      <Panel title="我的预警消息" sub={messages.data ? `未读 ${messages.data.unread} 条` : undefined} flush>
        {messages.isLoading && <Loading />}
        {messages.data && messages.data.rows.length === 0 && <Empty text="暂无消息" />}
        {messages.data && messages.data.rows.length > 0 && (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>级别</th>
                  <th>线路</th>
                  <th>内容</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {messages.data.rows.map((row) => (
                  <tr key={row.id} className={row.read_at ? "" : "unread-row"}>
                    <td className="nowrap">{row.created_at || ""}</td>
                    <td>
                      <Badge kind={row.level === "danger" ? "danger" : "warn"}>
                        {row.level === "danger" ? "超时" : "临近"}
                      </Badge>
                    </td>
                    <td>{row.route || ""}</td>
                    <td>
                      {row.title}
                      <div className="small muted">{row.body || ""}</div>
                    </td>
                    <td>{row.read_at ? "已读" : "未读"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {routes.data?.can_manage && (
        <div style={{ marginTop: 14 }}>
          <Panel
            title="线路截止时间与负责人"
            sub={`提前 ${routes.data.lead_minutes} 分钟提醒；超时后每 ${routes.data.repeat_minutes} 分钟重复`}
            flush
          >
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>线路</th>
                    <th>截止时间</th>
                    <th>负责人</th>
                    <th className="num">行数</th>
                    <th className="num">已复核</th>
                    <th>完成率</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {routeRows.map((row) => {
                    const stateInfo = STATE_TEXT[row.state] || { label: "-", kind: "" };
                    const names = (row.owners || []).map((owner) => owner.display_name || owner.username).join("、")
                      || "未指定（兜底管理员）";
                    return (
                      <tr key={row.route}>
                        <td>{row.route}</td>
                        <td className="nowrap">{row.deadline || "-"}</td>
                        <td>{names}</td>
                        <td className="num">{row.lines}</td>
                        <td className="num">{row.checked}</td>
                        <td>{row.rate === null || row.rate === undefined ? "-" : pct(row.rate)}</td>
                        <td>{stateInfo.kind ? <Badge kind={stateInfo.kind}>{stateInfo.label}</Badge> : stateInfo.label}</td>
                        <td>
                          <button className="btn btn-sm btn-ghost" onClick={() => openEditor(row, routes.data!.users)}>
                            编辑
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}

      {editing && (
        <Modal
          title={`线路预警设置 · ${editing.route.route}`}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button className="btn" onClick={() => setEditing(null)}>取消</button>
              <button className="btn btn-primary" onClick={saveRoute}>保存</button>
            </>
          }
        >
          <div className="field">
            <label>截止时间（HH:MM）</label>
            <input className="input" placeholder="17:00" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
          </div>
          <div className="field">
            <label>启用预警</label>
            <label className="check">
              <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> 启用
            </label>
          </div>
          <div className="field">
            <label>负责人（可多选）</label>
            {editing.users.map((user) => (
              <label key={user.id} className="check" style={{ display: "flex" }}>
                <input
                  type="checkbox"
                  checked={owners.includes(user.id)}
                  onChange={(event) =>
                    setOwners(event.target.checked ? [...owners, user.id] : owners.filter((id) => id !== user.id))
                  }
                />
                {user.display_name}（{user.username}）
              </label>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
