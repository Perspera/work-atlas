import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { Empty, Loading, PageHead, Panel } from "../components/ui";

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

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const audit = useQuery({
    queryKey: ["audit", page],
    queryFn: () => api<AuditData>("/api/audit", { query: { page } }),
  });

  const data = audit.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;

  return (
    <>
      <PageHead title="审计日志" />
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
                  {data.rows.length === 0 && (
                    <tr>
                      <td colSpan={6}><Empty text="暂无数据" /></td>
                    </tr>
                  )}
                  {data.rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.ts}</td>
                      <td>{row.username || "-"}</td>
                      <td className="mono small">{row.ip}</td>
                      <td>{row.action}</td>
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
