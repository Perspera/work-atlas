import { useEffect, useMemo, useRef, useState } from "react";
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
import { WidgetConfigModal, type WidgetCatalog } from "../features/widget-config";

const Grid = WidthProvider(GridLayout);
const HISTORY_LIMIT = 50;

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
  const [past, setPast] = useState<LayoutWidget[][]>([]);
  const [future, setFuture] = useState<LayoutWidget[][]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [configEdit, setConfigEdit] = useState<LayoutWidget | null>(null);

  // widgetsRef 为唯一事实源：拖动过程高频更新，事件回调里也能读到最新值
  const widgetsRef = useRef<LayoutWidget[]>([]);
  const dragBeforeRef = useRef<LayoutWidget[]>([]);

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
    queryFn: () => api<WidgetCatalog>("/api/widget-catalog"),
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
    widgetsRef.current = source.layout?.widgets || [];
    setWidgets(widgetsRef.current);
    setName(source.name);
    setPast([]);
    setFuture([]);
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

  // ---- 历史提交（结构性变更统一入口）
  const commit = (next: LayoutWidget[]) => {
    const before = widgetsRef.current;
    if (JSON.stringify(next) === JSON.stringify(before)) return;
    setPast((p) => [...p.slice(-(HISTORY_LIMIT - 1)), before]);
    setFuture([]);
    widgetsRef.current = next;
    setWidgets(next);
  };

  const applyLayout = (next: RGLLayout[]) => {
    const merged = widgetsRef.current.map((item) => {
      const found = next.find((entry) => entry.i === item.id);
      return found ? { ...item, x: found.x, y: found.y, w: found.w, h: found.h } : item;
    });
    widgetsRef.current = merged;
    setWidgets(merged);
  };

  const undo = () => {
    if (!past.length) return;
    const prev = past[past.length - 1];
    const current = widgetsRef.current;
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [current, ...f]);
    widgetsRef.current = prev;
    setWidgets(prev);
  };

  const redo = () => {
    if (!future.length) return;
    const next = future[0];
    const current = widgetsRef.current;
    setFuture((f) => f.slice(1));
    setPast((p) => [...p, current]);
    widgetsRef.current = next;
    setWidgets(next);
  };

  // 拖动/缩放结束才进历史；拖动过程由 onLayoutChange 高频更新
  const rememberDrag = () => {
    dragBeforeRef.current = widgetsRef.current;
  };
  const finishDrag = () => {
    const before = dragBeforeRef.current;
    if (JSON.stringify(widgetsRef.current) === JSON.stringify(before)) return;
    setPast((p) => [...p.slice(-(HISTORY_LIMIT - 1)), before]);
    setFuture([]);
  };

  const tidy = () => {
    // first-fit：按 y/x 排序后依次放进 12 列画布的第一个空位
    const sorted = [...widgetsRef.current].sort((a, b) => a.y - b.y || a.x - b.x);
    const placed: LayoutWidget[] = [];
    for (const widget of sorted) {
      let spot = { x: 0, y: 0 };
      for (let y = 0; ; y++) {
        let found = false;
        for (let x = 0; x + widget.w <= 12; x++) {
          const taken = placed.some(
            (p) => p.x < x + widget.w && p.x + p.w > x && p.y < y + widget.h && p.y + p.h > y,
          );
          if (!taken) {
            spot = { x, y };
            found = true;
            break;
          }
        }
        if (found) break;
      }
      placed.push({ ...widget, ...spot });
    }
    if (JSON.stringify(placed) === JSON.stringify(widgetsRef.current)) {
      toast("已经是紧凑的，无需整理", "ok");
      return;
    }
    commit(placed);
    toast("已整理布局", "ok");
  };

  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y（输入框聚焦时跳过）
  useEffect(() => {
    if (!canEdit) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const key = (event.key || "").toLowerCase();
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (key === "y") {
        event.preventDefault();
        redo();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const addPreset = (preset: WidgetCatalog["presets"][number]) => {
    const maxY = widgetsRef.current.reduce((max, item) => Math.max(max, item.y + item.h), 0);
    const widget: LayoutWidget = {
      id: `${preset.key}-${Date.now()}`,
      type: preset.type as LayoutWidget["type"],
      title: preset.title,
      spec: preset.spec,
      x: 0,
      y: maxY,
      w: preset.w || 6,
      h: preset.h || 4,
    };
    commit([...widgetsRef.current, widget]);
    setPaletteOpen(false);
  };

  const duplicate = (widget: LayoutWidget) => {
    commit([
      ...widgetsRef.current,
      { ...widget, id: `${widget.id}-copy-${Date.now()}`, title: `${widget.title} 副本`, y: widget.y + 1 },
    ]);
  };

  const remove = (widget: LayoutWidget) => {
    commit(widgetsRef.current.filter((item) => item.id !== widget.id));
  };

  const applyConfig = (next: { title: string; spec: Record<string, unknown>; text?: string }) => {
    if (!configEdit) return;
    commit(
      widgetsRef.current.map((item) =>
        item.id === configEdit.id ? { ...item, title: next.title, spec: next.spec, text: next.text } : item,
      ),
    );
    setConfigEdit(null);
  };

  const save = async () => {
    const layoutPayload = { widgets: widgetsRef.current };
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
        await api(`/api/pages/${ref}`, { method: "PUT", body: { target: "public", layout: { widgets: widgetsRef.current } } });
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
              ? "拖动标题移动组件，拖动右下角缩放；支持 Ctrl+Z 撤销 / Ctrl+Y 重做。"
              : "当前账号对该看板只有查看权限"}
          </div>
        </div>
        <div className="toolbar">
          {canEdit && (
            <>
              <button className="btn btn-sm" disabled={!past.length} onClick={undo} title="撤销 (Ctrl+Z)">撤销</button>
              <button className="btn btn-sm" disabled={!future.length} onClick={redo} title="重做 (Ctrl+Y)">重做</button>
              <button className="btn btn-sm" onClick={tidy} title="把所有组件往上紧凑排列">整理布局</button>
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
            compactType={null}
            preventCollision
            allowOverlap={false}
            draggableHandle=".dg-drag"
            draggableCancel=".no-drag"
            onDragStart={rememberDrag}
            onResizeStart={rememberDrag}
            onDragStop={finishDrag}
            onResizeStop={finishDrag}
            onLayoutChange={applyLayout}
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
                        title="配置数据集/维度/指标/筛选"
                        onClick={() => setConfigEdit(widget)}
                      >
                        设置
                      </button>
                      <button className="btn btn-sm btn-ghost" onClick={() => duplicate(widget)}>复制</button>
                      <button className="btn btn-sm btn-danger" onClick={() => remove(widget)}>
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
              (catalog.data?.presets || []).reduce<Record<string, WidgetCatalog["presets"]>>((groups, preset) => {
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

      {configEdit && catalog.data && (
        <WidgetConfigModal
          widget={configEdit}
          catalog={catalog.data}
          date={date}
          onClose={() => setConfigEdit(null)}
          onApply={applyConfig}
        />
      )}
    </>
  );
}
