import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { num } from "../lib/format";
import { Empty, Loading, PageHead, Panel } from "../components/ui";

interface SummaryCell {
  lines: number;
  amount: number | null;
}

interface SummaryRoute {
  label: string;
  lines: number;
  groups: number;
  amount: number | null;
  cells: Record<string, SummaryCell>;
}

interface SummaryMatrix {
  biz_date: string;
  zones: string[];
  routes: SummaryRoute[];
  zone_totals: Record<string, SummaryCell>;
  totals: { lines: number; groups: number; amount: number | null };
  with_amount: boolean;
}

export default function SummaryPrint({ date }: { date: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["summary-matrix", date],
    queryFn: () => api<SummaryMatrix>("/api/summary", { query: { date } }),
  });

  return (
    <>
      <PageHead
        title="单量表（打印版）"
        sub={`业务日期 ${date} · 承运商/线路 × 库区交叉表`}
      >
        <button className="btn btn-primary" onClick={() => window.print()}>打印</button>
        <button className="btn" onClick={() => window.history.back()}>返回</button>
      </PageHead>
      <Panel title="单量表">
        {isLoading && <Loading text="加载单量表" />}
        {error && <Empty text={(error as Error).message} />}
        {data && (
          <>
            <div className="small muted" style={{ marginBottom: 8 }}>
              口径：行数 = 发运明细行；库区取明细行自身的区；金额按万元展示；调拨出库统一归省外调拨/顺丰速运。
            </div>
            <div className="table-wrap" style={{ maxHeight: "70vh" }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>承运商/线路</th>
                    {data.zones.map((zone) => (
                      <th key={zone} className="num" colSpan={data.with_amount ? 2 : 1}>{zone}</th>
                    ))}
                    <th className="num">合计行数</th>
                    {data.with_amount && <th className="num">合计金额(万)</th>}
                    <th className="num">订单组数</th>
                  </tr>
                  <tr>
                    <th />
                    {data.zones.map((zone) => (
                      <th key={`${zone}-sub`} className="num small" colSpan={data.with_amount ? 2 : 1}>
                        行数{data.with_amount ? " / 金额(万)" : ""}
                      </th>
                    ))}
                    <th />
                    {data.with_amount && <th />}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.routes.length === 0 && (
                    <tr><td colSpan={2 + data.zones.length * (data.with_amount ? 2 : 1) + (data.with_amount ? 2 : 1)}><Empty text="无数据" /></td></tr>
                  )}
                  {data.routes.map((route) => (
                    <tr key={route.label}>
                      <td>{route.label}</td>
                      {data.zones.map((zone) => {
                        const cell = route.cells[zone];
                        return (
                          <Fragment key={zone}>
                            <td className="num">{num(cell?.lines || 0)}</td>
                            {data.with_amount && <td className="num">{num(cell?.amount, 2)}</td>}
                          </Fragment>
                        );
                      })}
                      <td className="num">{num(route.lines)}</td>
                      {data.with_amount && <td className="num">{num(route.amount, 2)}</td>}
                      <td className="num">{num(route.groups)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td><b>合计</b></td>
                    {data.zones.map((zone) => {
                      const cell = data.zone_totals[zone];
                      return (
                        <Fragment key={zone}>
                          <td className="num"><b>{num(cell?.lines || 0)}</b></td>
                          {data.with_amount && <td className="num"><b>{num(cell?.amount, 2)}</b></td>}
                        </Fragment>
                      );
                    })}
                    <td className="num"><b>{num(data.totals.lines)}</b></td>
                    {data.with_amount && <td className="num"><b>{num(data.totals.amount, 2)}</b></td>}
                    <td className="num"><b>{num(data.totals.groups)}</b></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </Panel>
    </>
  );
}
