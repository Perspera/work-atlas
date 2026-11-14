import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { api } from "../lib/api";
import { num } from "../lib/format";
import { hasPerm, useApp } from "../lib/store";
import { Badge, Empty, Kpi, KpiBand, Loading, Modal, PageHead, Panel } from "../components/ui";
import type { Layout } from "../features/dashboard";

interface BoardPage {
  kind: "page";
  key: string;
  name: string;
  source: string;
  public_version: number;
  personal_version: number;
  widgets: number;
  layout: Layout;
  can_edit: boolean;
  can_publish: boolean;
}

interface BoardDashboard {
  kind: "dashboard";
  id: number;
  name: string;
  version: number;
  widgets: number;
  layout: Layout;
  editable: boolean;
  is_public: boolean;
}

interface BoardsData {
  pages: BoardPage[];
  dashboards: BoardDashboard[];
  orphans: { id: number; name: string }[];
  screen: { items: string[]; interval: number; sound: boolean };
  can_screen: boolean;
  can_create: boolean;
  can_publish: boolean;
}

function MiniPreview({ layout }: { layout: Layout }) {
  const widgets = layout.widgets || [];
  const rows = Math.max(...widgets.map((item) => item.y + item.h), 1);
  if (!widgets.length) return <div className="hub-mini"><div className="hub-mini-empty">空看板</div></div>;
  return (
    <div className="hub-mini">
      {widgets.map((item) => (
        <div
          key={item.id}
          className="hub-cell"
          style={{
            left: `${(item.x / 12) * 100}%`,
            top: `${(item.y / rows) * 100}%`,
            width: `${(item.w / 12) * 100}%`,
            height: `${(item.h / rows) * 100}%`,
          }}
        />
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const me = useApp((state) => state.me);
  const toast = useApp((state) => state.toast);
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");

  const boards = useQuery({
    queryKey: ["boards"],
    queryFn: () => api<BoardsData>("/api/boards"),
  });

  const refresh = () => void boards.refetch();
  const data = boards.data;
  const screenItems = data?.screen.items || [];
  const canScreenConfig = hasPerm(me, "action.screen.config");

  const publish = async (item: BoardPage | BoardDashboard) => {
    if (!window.confirm("把该看板当前布局发布给所有人？已自建布局的同事保留自己的。")) return;
    try {
      if (item.kind === "page") {
        await api(`/api/pages/${item.key}`, {
          method: "PUT",
          body: { target: "public", layout: item.layout },
        });
      } else {
        await api(`/api/dashboards/${item.id}/publish`, { method: "POST" });
      }
      toast("已发布", "ok");
      refresh();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  const copy = async (item: BoardPage | BoardDashboard) => {
    try {
      if (item.kind === "page") {
        await api("/api/boards/from-page", {
          method: "POST",
          body: { key: item.key, name: `${item.name} 专题` },
        });
      } else {
        await api("/api/dashboards", {
          method: "POST",
          body: { name: `${item.name} 副本`, layout: item.layout },
        });
      }
      toast("已复制", "ok");
      refresh();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  const remove = async (item: BoardDashboard) => {
    if (!window.confirm("删除后不可恢复，确定？")) return;
    try {
      await api(`/api/dashboards/${item.id}`, { method: "DELETE" });
      toast("已删除", "ok");
      refresh();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  const resetPage = async (item: BoardPage) => {
    if (!window.confirm("删除我的布局，回到公共默认？")) return;
    try {
      await api(`/api/pages/${item.key}/reset`, { method: "POST" });
      toast("已恢复公共默认", "ok");
      refresh();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  const toggleScreen = async (id: string) => {
    if (!data) return;
    const items = [...screenItems];
    const at = items.indexOf(id);
    if (at >= 0) items.splice(at, 1);
    else items.push(id);
    try {
      await api("/api/screen", {
        method: "PUT",
        body: { items, interval: data.screen.interval, sound: data.screen.sound },
      });
      toast(at >= 0 ? "已移出大屏" : "已加入大屏", "ok");
      refresh();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  const create = async () => {
    try {
      const result = await api<{ id: number }>("/api/dashboards", {
        method: "POST",
        body: { name: name.trim() || "我的专题看板", layout: { widgets: [] } },
      });
      setCreateOpen(false);
      setName("");
      navigate(`/board/dash/${result.id}`);
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  const card = (item: BoardPage | BoardDashboard) => {
    const isPage = item.kind === "page";
    const screenId = isPage ? item.key : `dash:${item.id}`;
    const inScreen = screenItems.includes(screenId);
    return (
      <div className="hub-card" key={isPage ? `page-${item.key}` : `dash-${item.id}`}>
        <div className="hub-card-head">
          <span className="hub-name">{item.name}</span>
        </div>
        <div className="hub-badges">
          {isPage ? (
            <Badge kind="ok">导航页</Badge>
          ) : item.is_public ? (
            <Badge kind="ok">公共专题</Badge>
          ) : (
            <Badge>我的专题</Badge>
          )}
          <Badge>{item.widgets} 个组件</Badge>
          <span className="hub-ver">
            {isPage
              ? item.source === "personal"
                ? `我的 v${item.personal_version} / 公共 v${item.public_version}`
                : `公共 v${item.public_version}`
              : `v${item.version}`}
          </span>
        </div>
        <MiniPreview layout={item.layout} />
        <div className="hub-actions">
          <button
            className="btn btn-sm btn-primary"
            onClick={() => navigate(isPage ? `/board/page/${item.key}` : `/board/dash/${item.id}`)}
          >
            编辑
          </button>
          {(isPage || item.is_public) && (
            <button className="btn btn-sm" onClick={() => void publish(item)}>发布</button>
          )}
          <button className="btn btn-sm" onClick={() => void copy(item)}>复制</button>
          {!isPage && item.editable && (
            <button className="btn btn-sm btn-danger" onClick={() => void remove(item)}>删除</button>
          )}
          {isPage && item.personal_version > 0 && (
            <button className="btn btn-sm btn-ghost" onClick={() => void resetPage(item)}>恢复默认</button>
          )}
          {canScreenConfig && (
            <button className="btn btn-sm btn-ghost" onClick={() => void toggleScreen(screenId)}>
              {inScreen ? "移出大屏" : "加入大屏"}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <PageHead
        title="看板总台"
        sub="管理各导航页看板与专题看板：点「编辑」改布局，改完「发布」就更新到对应页面"
      >
        {data?.can_create && (
          <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>新建专题看板</button>
        )}
        <button className="btn" onClick={refresh}>刷新</button>
      </PageHead>

      {boards.isLoading && <Loading />}
      {boards.error && <Empty text={(boards.error as Error).message} />}
      {data && (
        <>
          <KpiBand cols={4}>
            <Kpi label="导航页看板" value={num(data.pages.length)} unit="个"
              sub={data.pages.map((item) => item.name).join(" / ") || "—"} />
            <Kpi label="固定分析页" value={num(1)} unit="个" sub="单量分析（今日 / 本周 / 本月 / 本季度）" />
            <Kpi label="专题看板" value={num(data.dashboards.length)} unit="个"
              sub={`私有 ${num(data.dashboards.filter((item) => !item.is_public).length)} · 共享 ${num(data.dashboards.filter((item) => item.is_public).length)}`} />
            <Kpi label="孤儿看板" value={num(data.orphans.length)} unit="个"
              warn={data.orphans.length > 0}
              sub={data.orphans.length > 0 ? "所属账号已删除，建议清理" : "无"} />
          </KpiBand>

          <Panel title="导航页看板" sub="编辑后发布，所有人打开该页就是新样式">
            <div className="hub-grid">{data.pages.map(card)}</div>
          </Panel>

          <div style={{ marginTop: 14 }}>
            <Panel title="固定分析页" sub="已改为固定布局，不在总台编辑">
              <button className="btn" onClick={() => navigate("/volume")}>
                打开“单量分析”（今日 / 本周 / 本月 / 本季度）
              </button>
            </Panel>
          </div>

          <div style={{ marginTop: 14 }}>
            <Panel title="专题看板" sub="自由画布，可发布成公共看板或设为大屏播放">
              {data.dashboards.length === 0 ? (
                <div className="small muted">还没有专题看板，点右上「新建专题看板」</div>
              ) : (
                <div className="hub-grid">{data.dashboards.map(card)}</div>
              )}
            </Panel>
          </div>

          {data.orphans.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <Panel title="待清理的孤儿看板" sub={`${data.orphans.length} 个（所属账号已删除）`}>
                <button
                  className="btn btn-danger"
                  onClick={async () => {
                    if (!window.confirm("会删除所属账号已不存在的看板，确定？")) return;
                    try {
                      const result = await api<{ deleted: number[] }>("/api/boards/cleanup", { method: "POST" });
                      toast(`已清理 ${result.deleted.length} 个`, "ok");
                      refresh();
                    } catch (error) {
                      toast((error as Error).message, "err");
                    }
                  }}
                >
                  全部清理
                </button>
              </Panel>
            </div>
          )}
        </>
      )}

      {createOpen && (
        <Modal
          title="新建专题看板"
          onClose={() => setCreateOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setCreateOpen(false)}>取消</button>
              <button className="btn btn-primary" onClick={create}>创建并编辑</button>
            </>
          }
        >
          <div className="field">
            <label>名称</label>
            <input className="input" placeholder="例如：承运商专题" value={name}
              onChange={(event) => setName(event.target.value)} />
          </div>
        </Modal>
      )}
    </>
  );
}
