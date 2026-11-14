import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { num } from "../lib/format";
import { Badge, Empty, Kpi, KpiBand, Loading, PageHead, Panel } from "../components/ui";

interface AuditRow {
  id: number;
  ts: string;
  username: string | null;
  ip: string;
  action: string;
  target: string;
  detail: string | null;
}

interface AuditData {
  total: number;
  page: number;
  size: number;
  rows: AuditRow[];
}

/** 动作胶囊：失败/异常用告警色，其余按读/写区分。 */
function actionKind(action: string) {
  const text = action.toLowerCase();
  if (text.includes("fail") || text.includes("error") || text.includes("deny")) return "danger";
  if (text.startsWith("delete") || text.startsWith("remove")) return "warn";
  if (text.startsWith("get") || text.startsWith("list") || text.includes("view")) return "";
  return "ok";
}

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const [draftUser, setDraftUser] = useState("");
  const [draftAction, setDraftAction] = useState("");
  const [draftTarget, setDraftTarget] = useState("");
  const [filters, setFilters] = useState({ user: "", action: "", target: "" });

  const audit = useQuery({
    queryKey: ["audit", page],
    queryFn: () => api<AuditData>("/api/audit", { query: { page } }),
  });

  const data = audit.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;

  const rows = (data?.rows || []).filter((row) => {
    if (filters.user && !(row.username || "").toLowerCase().includes(filters.user.toLowerCase())) return false;
    if (filters.action && !row.action.toLowerCase().includes(filters.action.toLowerCase())) return false;
    if (filters.target && !row.target.toLowerCase().includes(filters.target.toLowerCase())) return false;
    return true;
  });

  const apply = () => {
    setFilters({ user: draftUser, action: draftAction, target: draftTarget });
    setPage(1);
  };

  return (
    <>
      <PageHead title="审计日志" sub="登录、改数据、发布看板等关键动作全部留痕，按时间倒序">
        <span className="small muted">共 {data ? num(data.total) : "-"} 条</span>
      </PageHead>

      {data && (
        <KpiBand cols={4}>
          <Kpi label="日志条数" value={num(data.total)} unit="条" sub="按时间倒序" />
          <Kpi label="本页条数" value={num(rows.length)} unit="条"
            sub={
              filters.user || filters.action || filters.target
                ? "已按条件筛选（仅当前页）"
                : `每页 ${num(data.size)} 条`
            } />
          <Kpi label="用户" value={num(new Set(rows.map((row) => row.username || "—")).size)} unit="个"
            sub="本页出现的操作人" />
          <Kpi label="异常" value={num(rows.filter((row) => actionKind(row.action) === "danger").length)} unit="条"
            warn={rows.some((row) => actionKind(row.action) === "danger")}
            sub="本页失败/拒绝类动作" />
        </KpiBand>
      )}

      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="panel-body" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input className="input" style={{ height: 30, width: 140 }} placeholder="用户"
            value={draftUser} onChange={(event) => setDraftUser(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && apply()} />
          <input className="input" style={{ height: 30, width: 180 }} placeholder="动作"
            value={draftAction} onChange={(event) => setDraftAction(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && apply()} />
          <input className="input" style={{ height: 30, width: 200 }} placeholder="对象"
            value={draftTarget} onChange={(event) => setDraftTarget(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && apply()} />
          <button className="btn btn-sm" onClick={apply}>查询</button>
          {(filters.user || filters.action || filters.target) && (
            <button className="btn btn-sm btn-ghost"
              onClick={() => { setDraftUser(""); setDraftAction(""); setDraftTarget(""); setFilters({ user: "", action: "", target: "" }); setPage(1); }}>
              清空
            </button>
          )}
        </div>
      </div>

      <Panel flush>
        {audit.isLoading && <Loading />}
        {audit.error && <Empty text={(audit.error as Error).message} />}
        {data && (
          <>
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>用户</th>
                    <th>IP</th>
                    <th>动作</th>
                    <th>对象</th>
                    <th>详情</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="empty-cell"><Empty text="暂无数据" /></td>
                    </tr>
                  )}
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="small">{row.ts}</td>
                      <td>{row.username || "—"}</td>
                      <td className="mono small">{row.ip}</td>
                      <td><Badge kind={actionKind(row.action)}>{row.action}</Badge></td>
                      <td>{row.target}</td>
                      <td
                        className="small muted"
                        style={{ maxWidth: 520, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      >
                        {row.detail || ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <span>共 {data.total} 条 · 第 {data.page} / {totalPages} 页</span>
              <button className="btn btn-sm" disabled={data.page <= 1} onClick={() => setPage((prev) => Math.max(1, prev - 1))}>
                上一页
              </button>
              <button className="btn btn-sm" disabled={data.page >= totalPages} onClick={() => setPage((prev) => prev + 1)}>
                下一页
              </button>
            </div>
          </>
        )}
      </Panel>
    </>
  );
}
