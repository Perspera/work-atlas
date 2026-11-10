export interface PageDef {
  key: string;
  title: string;
  perm: string;
}

/** 导航顺序与权限码，与原前端 PAGES 保持一致。 */
export const PAGES: PageDef[] = [
  { key: "overview", title: "今日总览", perm: "page.overview" },
  { key: "volume", title: "单量分析", perm: "page.volume" },
  { key: "labor", title: "人工作业量", perm: "page.labor" },
  { key: "orders", title: "订单组登记", perm: "page.orders" },
  { key: "battery", title: "动力电池登记", perm: "page.battery" },
  { key: "waves", title: "波次登记", perm: "page.waves" },
  { key: "alerts", title: "预警中心", perm: "page.alerts" },
  { key: "dashboard", title: "看板总台", perm: "page.dashboard" },
  { key: "sources", title: "数据源", perm: "page.sources" },
  { key: "outbound", title: "出库归档", perm: "page.sources" },
  { key: "admin", title: "用户与权限", perm: "page.users" },
  { key: "audit", title: "审计日志", perm: "page.audit" },
];
