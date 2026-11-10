import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import GridLayout, { WidthProvider, type Layout as RGLLayout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import { api } from "../lib/api";
import { useBizDate } from "../lib/hooks";
import { hasPerm, useApp } from "../lib/store";
import { Empty, Loading, Modal } from "../components/ui";
import { WidgetCard, WidgetGrid, type Layout, type LayoutWidget } from "../features/dashboard";

const Grid = WidthProvider(GridLayout);

interface PageData {
  key: string;
  name: string;
  layout: Layout;
  source: string;
  can_edit: boolean;
  can_publish: boolean;
  public_version: number;
  personal_version: number;
}

interface DashData {
  id: number;
  name: string;
  layout: Layout;
  editable: boolean;
  can_publish: boolean;
  version: number;
  updated_at: string;
}

interface Preset {
  key: string;
  group: string;
  title: string;
  desc: string;
  type: LayoutWidget["type"];
  spec: Record<string, unknown>;
  w: number;
  h: number;
}

export default function BoardPage() {
  const { kind = "page", ref = "" } = useParams();
  const navigate = useNavigate();
  const date = useBizDate();
  const me = useApp((state) => state.me);
  const toast = useApp((state) => state.toast);
  const isPage = kind === "page";

  const [widgets, setWidgets] = useState<LayoutWidget[]>([]);
  const [name, setName] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [titleEdit, setTitleEdit] = useState<LayoutWidget | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);

  const pageQuery = useQuery({
    queryKey: ["board", "page", ref],
    queryFn: () => api<PageData>(`/api/pages/${ref}`),
    enabled: isPage && Boolean(ref),
  });
  const dashQuery = useQuery({
    queryKey: ["board", "dash", ref],
    queryFn: () => api<DashData>(`/api/dashboards/${ref}`),
    enabled: !isPage && Boolean(ref),
  });
  const catalog = useQuery({
    queryKey: ["widget-catalog"],
    queryFn: () => api<{ presets: Preset[] }>("/api/widget-catalog"),
  });

  const source = isPage ? pageQuery.data : dashQuery.data;
  const canEdit = Boolean(
    hasPerm(me, "action.dashboard.edit") &&
      (isPage ? (pageQuery.data?.can_edit ?? false) : (dashQuery.data?.editable ?? false)),
  );
  const canPublish = isPage ? pageQuery.data?.can_publish : dashQuery.data?.can_publish;
  const isLoading = isPage ? pageQuery.isLoading : dashQuery.isLoading;
  const error = isPage ? pageQuery.error : dashQuery.error;

  useEffect(() => {
    if (!source || loaded) return;
    setWidgets(source.layout?.widgets || []);
    setName(source.name);
    setLoaded(true);
  }, [source, loaded]);

  const layout: RGLLayout[] = useMemo(
    () => widgets.map((item) => ({ i: item.id, x: item.x, y: item.y, w: item.w, h: item.h, minW: 1, minH: 2 })),
    [widgets],
  );

  const reload = () => {
    void (isPage ? pageQuery.refetch() : dashQuery.refetch());
    setLoaded(false);
  };

  const addPreset = (preset: Preset) => {
    const maxY = widgets.reduce((max, item) => Math.max(max, item.y + item.h), 0);
    const widget: LayoutWidget = {
      id: `${preset.key}-${Date.now()}`,
      type: preset.type,
      title: preset.title,
      spec: preset.spec,
      x: 0,
      y: maxY,
      w: preset.w || 6,
      h: preset.h || 4,
    };
    setWidgets([...widgets, widget]);
    setPaletteOpen(false);
  };

  const duplicate = (widget: LayoutWidget) => {
    setWidgets([
      ...widgets,
      { ...widget, id: `${widget.id}-copy-${Date.now()}`, title: `${widget.title} 副本`, y: widget.y + 1 },
    ]);
  };

  const save = async () => {
    const layoutPayload = { widgets };
    try {
      if (isPage) {
        await api(`/api/pages/${ref}`, { method: "PUT", body: { target: "personal", layout: layoutPayload } });
      } else {
        await api(`/api/dashboards/${ref}`, { method: "PUT", body: { name, layout: layoutPayload } });
      }
      toast("已保存", "ok");
      reload();
    } catch (err) {
      toast((err as Error).message, "err");
    }
  };

  const publish = async () => {
    if (!window.confirm("把当前布局发布为公共默认？已自建布局的同事保留自己的。")) return;
    try {
      if (isPage) {
        await api(`/api/pages/${ref}`, { method: "PUT", body: { target: "public", layout: { widgets } } });
      } else {
        await api(`/api/dashboards/${ref}/publish`, { method: "POST" });
      }
      toast("已发布", "ok");
      reload();
    } catch (err) {
      toast((err as Error).message, "err");
    }
  };

  const resetPage = async () => {
    if (!window.confirm("删除我的布局，回到公共默认？")) return;
    try {
      await api(`/api/pages/${ref}/reset`, { method: "POST" });
      toast("已恢复公共默认", "ok");
      reload();
    } catch (err) {
      toast((err as Error).message, "err");
    }
  };

  if (isLoading) return <Loading />;
  if (error) return <Empty text={(error as Error).message} />;
  if (!source) return <Empty text="看板不存在" />;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{isPage ? `编辑导航页看板 · ${name}` : `编辑专题看板 · ${name}`}</h1>
          <div className="page-sub">
            {canEdit
              ? "拖动标题移动组件，拖动右下角缩放；改完点「保存」。组件详细配置向导将在 P4-4 提供。"
              : "当前账号对该看板只有查看权限"}
          </div>
        </div>
        <div className="toolbar">
          {canEdit && (
            <>
              <button className="btn btn-sm" onClick={() => setPaletteOpen(true)}>添加组件</button>
              <button className="btn btn-sm btn-primary" onClick={save}>保存</button>
              {canPublish && <button className="btn btn-sm" onClick={publish}>发布</button>}
              {isPage && <button className="btn btn-sm btn-ghost" onClick={resetPage}>恢复默认</button>}
            </>
          )}
          <button className="btn" onClick={() => navigate("/dashboard")}>返回总台</button>
        </div>
      </div>

      {canEdit ? (
        widgets.length === 0 ? (
          <Empty text="空看板，点「添加组件」开始" />
        ) : (
          <Grid
            className="layout"
            layout={layout}
            cols={12}
            rowHeight={60}
            margin={[12, 12]}
            draggableHandle=".dg-drag"
            draggableCancel=".no-drag"
            onLayoutChange={(next) => {
              setWidgets((prev) =>
                prev.map((item) => {
                  const found = next.find((entry) => entry.i === item.id);
                  return found ? { ...item, x: found.x, y: found.y, w: found.w, h: found.h } : item;
                }),
              );
            }}
          >
            {widgets.map((widget) => (
              <div key={widget.id}>
                <WidgetCard
                  widget={widget}
                  date={date}
                  actions={
                    <div className="toolbar no-drag" style={{ gap: 2 }}>
                      <button
                        className="btn btn-sm btn-ghost"
                        title="修改标题"
                        onClick={() => {
                          setTitleEdit(widget);
                          setTitleDraft(widget.title);
                        }}
                      >
                        设置
                      </button>
                      <button className="btn btn-sm btn-ghost" onClick={() => duplicate(widget)}>复制</button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => setWidgets(widgets.filter((item) => item.id !== widget.id))}
                      >
                        删除
                      </button>
                    </div>
                  }
                />
              </div>
            ))}
          </Grid>
        )
      ) : (
        <WidgetGrid layout={{ widgets }} date={date} />
      )}

      {paletteOpen && (
        <Modal title="添加组件" wide onClose={() => setPaletteOpen(false)}>
          {catalog.isLoading && <Loading />}
          <div className="preset-grid">
            {Object.entries(
              (catalog.data?.presets || []).reduce<Record<string, Preset[]>>((groups, preset) => {
                (groups[preset.group] = groups[preset.group] || []).push(preset);
                return groups;
              }, {}),
            ).map(([group, items]) => (
              <div className="preset-group" key={group}>
                <div className="preset-group-title">{group}</div>
                {items.map((preset) => (
                  <button key={preset.key} className="preset-card" onClick={() => addPreset(preset)}>
                    <div className="preset-top">
                      <span className="preset-title">{preset.title}</span>
                      <span className="badge">{preset.type}</span>
                    </div>
                    <div className="preset-desc">{preset.desc}</div>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </Modal>
      )}

      {titleEdit && (
        <Modal
          title="修改组件标题"
          onClose={() => setTitleEdit(null)}
          footer={
            <>
              <button className="btn" onClick={() => setTitleEdit(null)}>取消</button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setWidgets(
                    widgets.map((item) =>
                      item.id === titleEdit.id ? { ...item, title: titleDraft.trim() || item.title } : item,
                    ),
                  );
                  setTitleEdit(null);
                }}
              >
                确定
              </button>
            </>
          }
        >
          <div className="field">
            <label>标题</label>
            <input className="input" value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} />
          </div>
          <div className="small muted">数据集/维度/指标配置向导将在 P4-4 提供，当前可先用「添加组件」里的预设。</div>
        </Modal>
      )}
    </>
  );
}
