import { useNavigate } from "react-router-dom";

import { Empty, Loading, PageHead } from "../components/ui";
import { WidgetGrid, usePageLayout } from "../features/dashboard";
import { download } from "../lib/api";
import { useBizDate } from "../lib/hooks";
import { hasPerm, useApp } from "../lib/store";

const SUB = "今日订单量 / 登记 / 拣货 / 复核 / 出库 / 完成率；可拖拽编辑并发布为全员默认";

export default function OverviewPage() {
  const date = useBizDate();
  const navigate = useNavigate();
  const me = useApp((state) => state.me);
  const canExport = hasPerm(me, "action.export");
  const { data, isLoading, error, refetch } = usePageLayout("overview");

  return (
    <>
      <PageHead title="今日总览" sub={SUB}>
        {canExport && (
          <>
            <button className="btn" onClick={() => download("/api/export/summary.csv", { date })}>
              导出单量表 CSV
            </button>
            <button className="btn" onClick={() => navigate("/print")}>
              打印单量表
            </button>
          </>
        )}
        <button className="btn btn-ghost" onClick={() => void refetch()}>
          刷新
        </button>
      </PageHead>
      {isLoading && <Loading />}
      {error && <Empty text={(error as Error).message} />}
      {data && <WidgetGrid layout={data.layout} date={date} />}
    </>
  );
}
