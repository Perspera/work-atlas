import { Empty, Loading, PageHead } from "../components/ui";
import { WidgetGrid, usePageLayout } from "../features/dashboard";
import { useBizDate } from "../lib/hooks";

const SUB = "今日订单量 / 登记 / 拣货 / 复核 / 出库 / 完成率";

export default function OverviewPage() {
  const date = useBizDate();
  const { data, isLoading, error } = usePageLayout("overview");

  return (
    <>
      <PageHead title="今日总览" sub={SUB} />
      {isLoading && <Loading />}
      {error && <Empty text={(error as Error).message} />}
      {data && <WidgetGrid layout={data.layout} date={date} />}
    </>
  );
}
