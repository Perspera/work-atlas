import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { Loading, Modal } from "../components/ui";
import { WidgetBody, paletteFor, type LayoutWidget, type WidgetData } from "./dashboard";

// ---------------------------------------------------------------- catalog 类型（/api/widget-catalog）

export interface CatalogDataset {
  key: string;
  title: string;
  dims: string[];
}

interface MetricMeta {
  label: string;
  unit: string;
  kind: string;
}

interface FilterDef {
  key: string;
  label: string;
  type: string;
  options: { value: string; label: string }[];
  default: string;
}

export interface DatasetUI {
  group: string;
  desc: string;
  supports: string[];
  default_dimension: string;
  default_metrics: string[];
  filters: (string | FilterDef)[];
}

export interface WidgetCatalog {
  datasets: CatalogDataset[];
  dataset_metrics: Record<string, string[]>;
  dim_labels: Record<string, string>;
  metric_meta: Record<string, MetricMeta>;
  dataset_ui: Record<string, DatasetUI>;
  presets: {
    key: string;
    group: string;
    title: string;
    desc: string;
    type: string;
    spec: Record<string, unknown>;
    w: number;
    h: number;
  }[];
}

// ---------------------------------------------------------------- 常量（与旧版 app.js 对齐）

const DATASET_GROUP_ORDER = ["订单与波次", "作业与人效", "ERP 回传", "趋势", "今日总览", "预警"];

const METRIC_KIND_LABELS: Record<string, string> = {
  int: "数量",
  num: "数值",
  pct: "比例",
  money: "金额",
  hours: "时长",
};

/** 明细类数据集的固定表格列（与旧版 tableColumns 一致）。 */
const FIXED_TABLE_COLUMNS: Record<string, [string, string][]> = {
  battery: [
    ["order_date", "订单日期"], ["reg_date", "登记日期"], ["group_no", "订单组号"],
    ["dealer_short", "经销商"], ["part_code", "备件编码"], ["part_name", "备件名称"],
    ["lines", "行数"], ["qty", "数量"], ["amount", "金额"], ["zone", "库区"],
    ["doc_type", "单据类型"], ["freight_free", "是否免运费"], ["region", "区域"],
    ["carrier", "承运商"], ["dest_city", "送达城市"], ["picked", "拣货行数"],
    ["checked", "复核行数"], ["address", "地址"], ["confirmed", "状态"],
    ["dealer_full", "经销商全称"],
  ],
  overdue: [
    ["group_no", "订单组号"], ["wave_no", "波次号"], ["dealer", "经销商"],
    ["route", "线路"], ["zone", "库区"], ["lines", "总行数"], ["checked", "已复核"],
    ["remaining", "未复核"], ["amount", "金额(万)"], ["deadline", "截止时间"],
    ["tms_status", "运输单"],
  ],
  erp_detail: [
    ["seq", "序号"], ["group_no", "订单组号"], ["dealer", "经销商"], ["lines", "行数"],
    ["amount", "金额(元)"], ["zone", "库区"], ["doc_type", "单据类型"], ["freight_free", "免运费"],
    ["region", "区域"], ["route", "承运商"], ["wave_no", "波次号"], ["tms_status", "清洗"],
    ["assignee", "指派"], ["erp_status", "ERP状态"], ["erp_lines", "异常行数"],
    ["erp_message", "回传信息"], ["erp_time", "回传时间"],
  ],
};

const BATTERY_DEFAULT_HIDDEN = ["address", "confirmed", "dealer_full"];

// ---------------------------------------------------------------- 配置向导

interface ConfigModel {
  title: string;
  dataset: string;
  dimension: string;
  metrics: string[];
  limit: number;
  dir: "asc" | "desc";
  filter: Record<string, string>;
  compare: boolean;
  column_widths: Record<string, number>;
  column_order: string[];
  hidden_columns: string[];
  fields: string[];
  show_values: boolean;
  color_scheme: string;
  color: string;
}

export function WidgetConfigModal({
  widget,
  catalog,
  date,
  onClose,
  onApply,
}: {
  widget: LayoutWidget;
  catalog: WidgetCatalog;
  date: string;
  onClose: () => void;
  onApply: (next: { title: string; spec: Record<string, unknown>; text?: string }) => void;
}) {
  const isText = widget.type === "text";
  const original = widget.spec || {};
  const originalFilter = (original.filter || {}) as Record<string, string>;
  const [textDraft, setTextDraft] = useState(widget.text || "");

  const datasetsForType = useMemo(() => {
    const ui = catalog.dataset_ui || {};
    return (catalog.datasets || []).filter((item) => {
      if (widget.type === "alert") return item.key === "alerts";
      if (item.key === "alerts") return false;
      if (widget.type === "funnel") return item.key === "orders";
      if (isText) return false;
      const supports = ui[item.key]?.supports;
      return !supports || supports.indexOf(widget.type) >= 0;
    });
  }, [catalog, widget.type, isText]);

  const [model, setModel] = useState<ConfigModel>(() => {
    const fallback = datasetsForType[0]?.key || "orders";
    const dataset =
      typeof original.dataset === "string" && datasetsForType.some((d) => d.key === original.dataset)
        ? original.dataset
        : fallback;
    const ui = catalog.dataset_ui?.[dataset];
    return {
      title: widget.title || "",
      dataset,
      dimension: (original.dimension as string) || ui?.default_dimension || "",
      metrics: ((original.metrics as string[]) || ["rows"]).slice(),
      limit: Number(original.limit) || 10,
      dir: ((original.sort as { dir?: string })?.dir === "asc" ? "asc" : "desc") as "asc" | "desc",
      filter: { ...originalFilter },
      compare: original.compare === true,
      column_widths: { ...((original.column_widths as Record<string, number>) || {}) },
      column_order: ((original.column_order as string[]) || []).slice(),
      hidden_columns: ((original.hidden_columns as string[]) || []).slice(),
      fields: ((original.fields as string[]) || []).slice(),
      show_values: original.show_values !== false,
      color_scheme: (original.color_scheme as string) || "",
      color: (original.color as string) || "",
    };
  });

  const uiOf = (key: string) => catalog.dataset_ui?.[key];
  const dimsOf = (key: string) => catalog.datasets.find((d) => d.key === key)?.dims || [];
  const metricsOf = (key: string) =>
    (catalog.dataset_metrics[key] || Object.keys(catalog.metric_meta)).filter((m) => catalog.metric_meta[m]);
  const dimLabel = (dim: string) => catalog.dim_labels?.[dim] || dim;

  const tableColumns = (dataset: string, dimension: string): [string, string][] => {
    if (FIXED_TABLE_COLUMNS[dataset]) return FIXED_TABLE_COLUMNS[dataset];
    const cols: [string, string][] = [["label", dimLabel(dimension)]];
    metricsOf(dataset).forEach((key) => cols.push([key, catalog.metric_meta[key]?.label || key]));
    return cols;
  };

  // 切换数据集：重置分组/指标/筛选为该数据集的默认（与旧版 datasetDefaultModel 一致）
  const switchDataset = (key: string) => {
    const ui = uiOf(key);
    const filter: Record<string, string> = {};
    (ui?.filters || []).forEach((f) => {
      if (f && typeof f === "object" && f.key) filter[f.key] = f.default;
    });
    setModel((prev) => ({
      ...prev,
      dataset: key,
      dimension: ui?.default_dimension || "",
      metrics: (ui?.default_metrics || ["rows"]).slice(),
      filter,
      column_widths: {},
      column_order: [],
      hidden_columns: [],
      fields: [],
    }));
  };

  const textFilterKeys = (key: string) =>
    (uiOf(key)?.filters || []).filter((f): f is string => typeof f === "string");
  const typedFilterDefs = (key: string) =>
    (uiOf(key)?.filters || []).filter((f): f is FilterDef => Boolean(f && typeof f === "object" && f.key));

  // ---- 表格显示字段（派生，不直接改 model；勾选时同步三份状态）
  const allTableKeys = widget.type === "table" ? tableColumns(model.dataset, model.dimension).map((c) => c[0]) : [];
  const effectiveFields = useMemo(() => {
    if (widget.type !== "table") return [];
    const kept = model.fields.filter((key) => allTableKeys.indexOf(key) >= 0);
    if (kept.length) return kept;
    if (model.dataset === "battery") return allTableKeys.filter((key) => BATTERY_DEFAULT_HIDDEN.indexOf(key) < 0);
    if (model.dataset === "erp_detail" || model.dataset === "overdue") return allTableKeys.slice();
    return ["label", ...model.metrics];
  }, [widget.type, model.fields, model.dataset, model.dimension, model.metrics, allTableKeys]);

  const toggleField = (key: string, checked: boolean) => {
    setModel((prev) => {
      let fields = prev.fields.filter((f) => allTableKeys.indexOf(f) >= 0);
      let hidden = prev.hidden_columns.slice();
      let order = prev.column_order.filter((f) => allTableKeys.indexOf(f) >= 0);
      if (!order.length) order = allTableKeys.slice();
      if (checked) {
        if (fields.indexOf(key) < 0) fields.push(key);
        hidden = hidden.filter((x) => x !== key);
        if (order.indexOf(key) < 0) order.push(key);
      } else {
        fields = fields.filter((x) => x !== key);
        if (hidden.indexOf(key) < 0) hidden.push(key);
      }
      return { ...prev, fields, hidden_columns: hidden, column_order: order };
    });
  };

  // ---- 生成 spec（与旧版 collectSpec 一致）
  const collectSpec = (): Record<string, unknown> => {
    const filter: Record<string, string> = {};
    Object.entries(model.filter).forEach(([key, value]) => {
      if (value !== "" && value !== null && value !== undefined) filter[key] = value;
    });
    textFilterKeys(model.dataset).forEach((key) => {
      if (!filter[key]) delete filter[key];
    });
    const spec: Record<string, unknown> = {
      dataset: model.dataset,
      dimension: model.dimension || "",
      metrics: model.metrics.length ? model.metrics.slice() : ["rows"],
      limit: model.limit,
      sort: { dir: model.dir },
      filter,
    };
    if (widget.type === "kpi" && model.compare) spec.compare = true;
    if (model.color_scheme) spec.color_scheme = model.color_scheme;
    if (model.color) spec.color = model.color;
    if (model.show_values === false) spec.show_values = false;
    if (widget.type === "kpi") delete spec.dimension;
    if (model.dataset === "erp_detail") {
      spec.dimension = "";
      spec.metrics = ["rows"];
    }
    if (model.dataset === "battery") {
      spec.dimension = "";
      spec.metrics = ["rows"];
    }
    if (widget.type === "table") {
      if (model.dataset !== "battery" && model.dataset !== "erp_detail") {
        const chosen = effectiveFields.filter((key) => key !== "label" && catalog.metric_meta[key]);
        spec.metrics = chosen.length ? chosen : ["rows"];
      }
      spec.fields = effectiveFields.slice();
      const order = model.column_order.length ? model.column_order : allTableKeys;
      spec.column_order = order.slice();
      const hidden: string[] = [];
      allTableKeys.forEach((key) => {
        if (effectiveFields.indexOf(key) < 0) hidden.push(key);
      });
      spec.hidden_columns = hidden;
      const widths: Record<string, number> = {};
      Object.entries(model.column_widths).forEach(([key, px]) => {
        if (px >= 40 && px <= 600) widths[key] = px;
      });
      if (Object.keys(widths).length) spec.column_widths = widths;
    }
    return spec;
  };

  // ---- 实时预览（300ms 防抖；以 spec 内容为依赖，内容不变不重复请求）
  const specJson = JSON.stringify(collectSpec());
  const [previewSpec, setPreviewSpec] = useState<Record<string, unknown>>(() => JSON.parse(specJson));
  useEffect(() => {
    const timer = setTimeout(() => setPreviewSpec(JSON.parse(specJson)), 300);
    return () => clearTimeout(timer);
  }, [specJson]);
  const preview = useQuery({
    queryKey: ["widget-preview", widget.type, date, previewSpec],
    queryFn: () =>
      api<WidgetData>("/api/widget", {
        method: "POST",
        body: { widget_type: widget.type, date, spec: previewSpec, text: textDraft },
      }),
    enabled: !isText,
    staleTime: 0,
    gcTime: 0,
  });

  const apply = () => {
    onApply({
      title: model.title.trim() || widget.title,
      spec: collectSpec(),
      text: isText ? textDraft : undefined,
    });
  };

  // ---- 渲染片段
  const isKpi = widget.type === "kpi";
  const showDim =
    !isKpi && widget.type !== "funnel" && model.dataset !== "erp_detail" && model.dataset !== "alerts" &&
    dimsOf(model.dataset).length > 0;
  const dims = dimsOf(model.dataset);
  const metricList = metricsOf(model.dataset);
  const metricGroups: Record<string, string[]> = {};
  metricList.forEach((key) => {
    const kind = catalog.metric_meta[key]?.kind;
    const label = METRIC_KIND_LABELS[kind] || "其他";
    (metricGroups[label] = metricGroups[label] || []).push(key);
  });
  const showColors = ["kpi", "bar", "line", "pie", "funnel", "progress"].indexOf(widget.type) >= 0;
  const showValuesToggle = ["bar", "line", "pie", "funnel"].indexOf(widget.type) >= 0;

  if (isText) {
    return (
      <Modal
        title="组件配置"
        onClose={onClose}
        footer={
          <>
            <button className="btn" onClick={onClose}>取消</button>
            <button className="btn btn-primary" onClick={apply}>应用</button>
          </>
        }
      >
        <div className="field">
          <label>标题</label>
          <input className="input" value={model.title} onChange={(e) => setModel({ ...model, title: e.target.value })} />
        </div>
        <div className="field">
          <label>文本内容</label>
          <textarea
            className="input"
            rows={4}
            value={textDraft}
            onChange={(e) => setTextDraft(e.target.value)}
          />
        </div>
      </Modal>
    );
  }

  const groupedDatasets: Record<string, CatalogDataset[]> = {};
  datasetsForType.forEach((d) => {
    const group = uiOf(d.key)?.group || "其他";
    (groupedDatasets[group] = groupedDatasets[group] || []).push(d);
  });
  const groupOrder = DATASET_GROUP_ORDER.filter((g) => groupedDatasets[g]);
  Object.keys(groupedDatasets).forEach((g) => {
    if (groupOrder.indexOf(g) < 0) groupOrder.push(g);
  });

  const visibleTableCols = widget.type === "table"
    ? tableColumns(model.dataset, model.dimension).filter(([key]) => effectiveFields.indexOf(key) >= 0)
    : [];

  return (
    <Modal
      title="组件配置"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={apply}>应用</button>
        </>
      }
    >
      <div className="field">
        <label>标题</label>
        <input className="input" value={model.title} onChange={(e) => setModel({ ...model, title: e.target.value })} />
      </div>
      <div className="grid cols-2">
        <div className="field">
          <label>看什么数据</label>
          <select className="select" value={model.dataset} onChange={(e) => switchDataset(e.target.value)}>
            {groupOrder.map((group) => (
              <optgroup key={group} label={group}>
                {(groupedDatasets[group] || []).map((d) => (
                  <option key={d.key} value={d.key}>{d.title}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <div className="help">{uiOf(model.dataset)?.desc || "选择要分析的数据范围"}</div>
        </div>
        <div className="field">
          <label>按什么分组</label>
          {showDim ? (
            <select
              className="select"
              value={model.dimension}
              onChange={(e) => setModel({ ...model, dimension: e.target.value })}
            >
              {dims.map((dim) => (
                <option key={dim} value={dim}>{dimLabel(dim)}</option>
              ))}
            </select>
          ) : (
            <div className="help" style={{ marginTop: 8 }}>
              该数据集无需分组：{isKpi ? "KPI 直接显示一个数" : "按明细行展示"}
            </div>
          )}
        </div>
      </div>

      <div className="field">
        <label>看什么指标</label>
        {model.dataset === "erp_detail" || model.dataset === "alerts" ? (
          <div className="small muted">该数据集的指标固定为“行数/明细”，无需选择。</div>
        ) : model.dataset === "battery" ? (
          <div className="small muted">动力电池明细组件使用固定列：订单组/备件编码/名称/行数/数量/金额/拣货/复核。</div>
        ) : (
          Object.entries(metricGroups).map(([group, keys]) => (
            <div className="metric-group" key={group}>
              <div className="metric-group-title">{group}</div>
              <div className="metric-checks">
                {keys.map((key) => {
                  const on = model.metrics.indexOf(key) >= 0;
                  return (
                    <label className="check" key={key}>
                      <input
                        type={isKpi ? "radio" : "checkbox"}
                        name={isKpi ? "cw-metric" : undefined}
                        checked={on}
                        onChange={() => {
                          if (isKpi) {
                            setModel({ ...model, metrics: [key] });
                          } else {
                            const next = on ? model.metrics.filter((m) => m !== key) : [...model.metrics, key];
                            setModel({ ...model, metrics: next.length ? next : ["rows"] });
                          }
                        }}
                      />{" "}
                      {catalog.metric_meta[key]?.label || key}
                    </label>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {isKpi && (
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={model.compare}
              onChange={(e) => setModel({ ...model, compare: e.target.checked })}
            />{" "}
            显示较上日比较
          </label>
          <div className="help">以同一指标与上一业务日比较，显示环比百分比</div>
        </div>
      )}

      {model.dataset !== "battery" && (
        <div className="field">
          <label>固定筛选（可留空）</label>
          {typedFilterDefs(model.dataset).map((f) => (
            <div className="field" key={f.key} style={{ marginBottom: 6 }}>
              <label style={{ fontWeight: 500 }}>{f.label || f.key}</label>
              <div className="cw-radio">
                {f.options.map((opt) => (
                  <label className="check" key={opt.value}>
                    <input
                      type="radio"
                      name={`cw-filter-${f.key}`}
                      checked={(model.filter[f.key] || f.default) === opt.value}
                      onChange={() => setModel({ ...model, filter: { ...model.filter, [f.key]: opt.value } })}
                    />{" "}
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>
          ))}
          {textFilterKeys(model.dataset).length > 0 && (
            <div className="grid cols-3">
              {textFilterKeys(model.dataset).map((key) => (
                <input
                  key={key}
                  className="input"
                  placeholder={dimLabel(key)}
                  value={model.filter[key] || ""}
                  onChange={(e) => {
                    const next = { ...model.filter };
                    if (e.target.value.trim()) next[key] = e.target.value.trim();
                    else delete next[key];
                    setModel({ ...model, filter: next });
                  }}
                />
              ))}
            </div>
          )}
          {typedFilterDefs(model.dataset).length === 0 && textFilterKeys(model.dataset).length === 0 && (
            <div className="small muted">该数据集没有可配置的筛选。</div>
          )}
        </div>
      )}

      {widget.type === "table" && (
        <div className="field">
          <label>
            显示字段 <span className="small muted">（可选择当前数据集全部字段）</span>
          </label>
          <div className="grid cols-3">
            {tableColumns(model.dataset, model.dimension).map(([key, label]) => (
              <label className="check" key={key}>
                <input
                  type="checkbox"
                  checked={effectiveFields.indexOf(key) >= 0}
                  onChange={(e) => toggleField(key, e.target.checked)}
                />{" "}
                {label}
              </label>
            ))}
          </div>
        </div>
      )}

      {widget.type === "table" && visibleTableCols.length > 0 && (
        <div className="field">
          <label>
            列宽 <span className="small muted">（像素，留空自动）</span>
          </label>
          <div className="grid cols-3">
            {visibleTableCols.map(([key, label]) => (
              <div className="field" key={key} style={{ marginBottom: 6 }}>
                <label>{label}</label>
                <input
                  className="input"
                  type="number"
                  min={40}
                  max={600}
                  step={10}
                  value={model.column_widths[key] ?? ""}
                  onChange={(e) => {
                    const px = Number(e.target.value);
                    const next = { ...model.column_widths };
                    if (px >= 40 && px <= 600) next[key] = px;
                    else delete next[key];
                    setModel({ ...model, column_widths: next });
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {showColors && (
        <div className="field">
          <label>
            配色 <span className="small muted">（仅影响当前组件）</span>
          </label>
          <div className="grid cols-2" style={{ marginBottom: 8 }}>
            <select
              className="select"
              value={model.color_scheme}
              onChange={(e) => setModel({ ...model, color_scheme: e.target.value, color: "" })}
            >
              <option value="">默认（品牌蓝）</option>
              <option value="macaron">马卡龙</option>
              <option value="dopamine">多巴胺</option>
            </select>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setModel({ ...model, color_scheme: "", color: "" })}
            >
              恢复默认
            </button>
          </div>
          <div className="cw-swatches">
            {(paletteFor({ color_scheme: model.color_scheme } as Record<string, unknown>) || ["#1d5fbf"]).map((color) => (
              <button
                key={color}
                type="button"
                className={`cw-swatch${model.color === color ? " active" : ""}`}
                style={{ background: color }}
                title={color}
                onClick={() => setModel({ ...model, color })}
              />
            ))}
          </div>
        </div>
      )}

      {showValuesToggle && (
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={model.show_values}
              onChange={(e) => setModel({ ...model, show_values: e.target.checked })}
            />{" "}
            显示数值
          </label>
        </div>
      )}

      <div className="grid cols-2">
        <div className="field">
          <label>取前 N 项</label>
          <input
            className="input"
            type="number"
            min={1}
            max={200}
            value={model.limit}
            onChange={(e) =>
              setModel({ ...model, limit: Math.max(1, Math.min(200, Number(e.target.value) || 10)) })
            }
          />
        </div>
        <div className="field">
          <label>排序</label>
          <select
            className="select"
            value={model.dir}
            onChange={(e) => setModel({ ...model, dir: e.target.value as "asc" | "desc" })}
          >
            <option value="desc">从大到小</option>
            <option value="asc">从小到大</option>
          </select>
        </div>
      </div>

      <div className="field">
        <label>
          效果预览 <span className="small muted">（当前业务日期 {date}）</span>
        </label>
        <div className="cw-preview">
          {preview.isLoading ? (
            <Loading text="预览中" />
          ) : preview.error ? (
            <span className="small" style={{ color: "var(--danger)" }}>{(preview.error as Error).message}</span>
          ) : preview.data ? (
            <div style={{ height: 220 }}>
              <WidgetBody
                type={widget.type}
                data={preview.data}
                palette={paletteFor(collectSpec())}
                showValues={model.show_values}
              />
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
