import type { ReactNode } from "react";

import { Empty } from "../components/ui";
import { hasPerm, useApp } from "../lib/store";

/** 直接输入 URL 时不具备权限的页面给出提示，与旧版一致。 */
export function Guard({ perm, children }: { perm: string; children: ReactNode }) {
  const me = useApp((state) => state.me);
  if (!hasPerm(me, perm)) return <Empty text="当前账号没有该页面权限，请联系管理员" />;
  return <>{children}</>;
}

export function Placeholder({ title }: { title: string }) {
  return <Empty text={`${title}（React 版正在迁移，旧界面仍可正常使用）`} />;
}
