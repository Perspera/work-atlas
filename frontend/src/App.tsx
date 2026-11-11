import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { ChangePasswordPage, LoginPage, SetupPage } from "./app/auth";
import { Guard, Placeholder } from "./app/guard";
import { PAGES, type PageDef } from "./app/pages";
import { Shell } from "./app/shell";
import { Loading, Toaster } from "./components/ui";
import { AUTH_EVENT } from "./lib/api";
import { useMe } from "./lib/hooks";
import { useApp } from "./lib/store";
import AdminPage from "./pages/admin";
import AlertsPage from "./pages/alerts";
import AuditPage from "./pages/audit";
import SummaryPrint from "./features/summary-print";
import { useBizDate } from "./lib/hooks";
import BatteryPage from "./pages/battery";
import BoardPage from "./pages/board";
import DashboardPage from "./pages/dashboard";
import LaborPage from "./pages/labor";
import OrdersPage from "./pages/orders";
import OutboundPage from "./pages/outbound";
import OverviewPage from "./pages/overview";
import ScreenPage from "./pages/screen";
import SourcesPage from "./pages/sources";
import VolumePage from "./pages/volume";
import WavesPage from "./pages/waves";

function pageElement(page: PageDef) {
  switch (page.key) {
    case "overview":
      return <OverviewPage />;
    case "volume":
      return <VolumePage />;
    case "labor":
      return <LaborPage />;
    case "orders":
      return <OrdersPage />;
    case "battery":
      return <BatteryPage />;
    case "waves":
      return <WavesPage />;
    case "alerts":
      return <AlertsPage />;
    case "dashboard":
      return <DashboardPage />;
    case "sources":
      return <SourcesPage />;
    case "outbound":
      return <OutboundPage />;
    case "admin":
      return <AdminPage />;
    case "audit":
      return <AuditPage />;
    default:
      return <Placeholder title={page.title} />;
  }
}

export default function App() {
  const { data: me, isLoading, error, refetch } = useMe();
  const setMe = useApp((state) => state.setMe);
  const date = useBizDate();

  useEffect(() => {
    if (me) setMe(me);
  }, [me, setMe]);

  // 401（会话失效）与 428（默认口令）都通过重新拉取 /api/me 让界面回到正确分支
  useEffect(() => {
    const handler = () => {
      void refetch();
    };
    window.addEventListener(AUTH_EVENT, handler);
    return () => window.removeEventListener(AUTH_EVENT, handler);
  }, [refetch]);

  if (isLoading) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <Loading text="正在连接看板服务" />
        </div>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="auth-title">连接失败</div>
          <div className="auth-sub">{(error as Error)?.message || "无法连接看板服务"}</div>
        </div>
      </div>
    );
  }

  if (me.setup) {
    return <SetupPage siteTitle={me.site_title} onDone={() => void refetch()} />;
  }
  if (!me.authenticated) {
    return <LoginPage siteTitle={me.site_title} onDone={() => void refetch()} />;
  }
  if (me.user?.must_change_pwd) {
    return <ChangePasswordPage forced siteTitle={me.site_title} onDone={() => void refetch()} />;
  }

  return (
    <>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Navigate to="/overview" replace />} />
          {PAGES.map((page) => (
            <Route
              key={page.key}
              path={page.key}
              element={<Guard perm={page.perm}>{pageElement(page)}</Guard>}
            />
          ))}
          <Route
            path="board/:kind/:ref"
            element={<Guard perm="page.dashboard"><BoardPage /></Guard>}
          />
          <Route path="screen" element={<Guard perm="page.screen"><ScreenPage /></Guard>} />
          <Route
            path="print"
            element={<Guard perm="action.export"><SummaryPrint date={date} /></Guard>}
          />
          <Route path="*" element={<Placeholder title="页面不存在" />} />
        </Route>
      </Routes>
      <Toaster />
    </>
  );
}
