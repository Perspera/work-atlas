export interface PageDef {
  key: string;
  title: string;
  perm: string;
  /** 左侧导航分组，与样卡一致：作业 / 分析 / 数据 / 管理 */
  group: string;
}

/** 导航顺序与权限码，与原前端 PAGES 保持一致。 */
export const PAGES: PageDef[] = [
  { key: "overview", title: "今日总览", perm: "page.overview", group: "作业" },
  { key: "volume", title: "单量分析", perm: "page.volume", group: "作业" },
  { key: "labor", title: "人工作业量", perm: "page.labor", group: "作业" },
  { key: "orders", title: "订单组登记", perm: "page.orders", group: "作业" },
  { key: "battery", title: "动力电池登记", perm: "page.battery", group: "作业" },
  { key: "waves", title: "波次登记", perm: "page.waves", group: "作业" },
  { key: "alerts", title: "预警中心", perm: "page.alerts", group: "作业" },
  { key: "dashboard", title: "看板总台", perm: "page.dashboard", group: "分析" },
  { key: "sources", title: "数据源", perm: "page.sources", group: "数据" },
  { key: "outbound", title: "出库归档", perm: "page.sources", group: "数据" },
  { key: "admin", title: "用户与权限", perm: "page.users", group: "管理" },
  { key: "audit", title: "审计日志", perm: "page.audit", group: "管理" },
];

/** 按分组折叠导航，保持 PAGES 的原始顺序。 */
export function navGroups(pages: PageDef[]): { name: string; pages: PageDef[] }[] {
  const groups: { name: string; pages: PageDef[] }[] = [];
  for (const page of pages) {
    const last = groups[groups.length - 1];
    if (last && last.name === page.group) last.pages.push(page);
    else groups.push({ name: page.group, pages: [page] });
  }
  return groups;
}
