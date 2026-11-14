import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { api } from "../lib/api";
import { clock } from "../lib/format";
import { useBizDate } from "../lib/hooks";
import { Empty, Loading } from "../components/ui";
import { WidgetGrid, type LayoutWidget } from "../features/dashboard";

interface ScreenItem {
  id: string;
  title: string;
  layout: { widgets: LayoutWidget[] };
}

interface OverdueItem {
  route: string;
  remaining: number;
  deadline: string;
  remaining_minutes?: number;
}

interface ScreenData {
  items: ScreenItem[];
  interval: number;
  sound: boolean;
  date: string;
  state: { overdue: OverdueItem[]; due_soon: OverdueItem[] };
  unread: number;
}

const SCREEN_ROW = 84;
const SCREEN_GAP = 12;
/** 大屏上内容不足一屏时，把行高放大到最多 140px，避免下半屏留白。 */
const SCREEN_ROW_MAX = 140;

function beep() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    window.setTimeout(() => {
      osc.stop();
      void ctx.close();
    }, 600);
  } catch {
    /* 浏览器未授权音频时忽略 */
  }
}

/** 按行分页：整块组件不切半，所有组件至少出现一次。 */
function paginate(widgets: LayoutWidget[], maxRows: number): LayoutWidget[][] {
  const sorted = [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);
  const pages: LayoutWidget[][] = [];
  let current: LayoutWidget[] = [];
  let start = 0;
  let bottom = 0;

  const flush = () => {
    if (!current.length) return;
    pages.push(current);
    current = [];
  };

  sorted.forEach((widget) => {
    const y = Math.max(0, widget.y || 0);
    const h = Math.max(1, widget.h || 1);
    if (!current.length) {
      start = y;
      bottom = y + h;
    } else if (Math.max(bottom, y + h) - start > maxRows) {
      flush();
      start = y;
      bottom = y + h;
    } else {
      bottom = Math.max(bottom, y + h);
    }
    current.push({ ...widget, y: y - start });
    bottom = Math.max(bottom, y + h);
  });
  flush();
  return pages;
}

export default function ScreenPage() {
  const navigate = useNavigate();
  const date = useBizDate();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const [now, setNow] = useState(clock());
  const [maxRows, setMaxRows] = useState(5);
  const [bodyHeight, setBodyHeight] = useState(0);
  const [idle, setIdle] = useState(false);
  const overdueSeen = useRef(0);

  const { data, isLoading, error, dataUpdatedAt } = useQuery({
    queryKey: ["screen-data", date],
    queryFn: () => api<ScreenData>("/api/screen/data", { query: { date } }),
    refetchInterval: 60_000,
    enabled: Boolean(date),
  });

  useEffect(() => {
    document.body.classList.add("screen-mode");
    return () => document.body.classList.remove("screen-mode");
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(clock()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const compute = () => {
      const body = document.getElementById("sc-body");
      const height = body ? body.clientHeight : window.innerHeight - 56;
      setBodyHeight(height);
      setMaxRows(Math.max(3, Math.floor((height - 24) / (SCREEN_ROW + SCREEN_GAP))));
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [data]);

  // 大屏无人操作时淡出顶部控制按钮，鼠标/键盘再次活动时恢复。
  useEffect(() => {
    let timer = window.setTimeout(() => setIdle(true), 3000);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), 3000);
    };
    window.addEventListener("mousemove", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);

  const slides = useMemo(() => {
    if (!data) return [] as { title: string; widgets: LayoutWidget[] }[];
    return data.items.flatMap((item) =>
      paginate(item.layout.widgets || [], maxRows).map((widgets) => ({ title: item.title, widgets })),
    );
  }, [data, maxRows]);

  const current = slides[index];

  // 按当前页实际行数把行高撑满可视区（上限 140px），分页与组件数量都不变。
  const rowHeight = useMemo(() => {
    if (!current || !bodyHeight) return SCREEN_ROW;
    const used = Math.max(...current.widgets.map((item) => item.y + item.h), 1);
    const fit = Math.floor((bodyHeight - 40 - SCREEN_GAP * (used + 1)) / used);
    return Math.min(SCREEN_ROW_MAX, Math.max(SCREEN_ROW, fit));
  }, [current, bodyHeight]);

  const chartFontSize = rowHeight >= 104 ? 14 : 13;

  useEffect(() => {
    setIndex(0);
  }, [slides.length]);

  useEffect(() => {
    if (!data || paused || slides.length <= 1) return;
    const timer = window.setInterval(
      () => setIndex((prev) => (prev + 1) % slides.length),
      Math.max(5, data.interval || 15) * 1000,
    );
    return () => window.clearInterval(timer);
  }, [data, paused, slides.length]);

  useEffect(() => {
    if (!soundOn || !data) return;
    if (data.state.overdue.length > overdueSeen.current) beep();
    overdueSeen.current = data.state.overdue.length;
  }, [data, soundOn]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") setIndex((prev) => (slides.length ? (prev + 1) % slides.length : 0));
      else if (event.key === "ArrowLeft") setIndex((prev) => (slides.length ? (prev - 1 + slides.length) % slides.length : 0));
      else if (event.key === " ") setPaused((prev) => !prev);
      else if (event.key === "Escape") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else navigate("/overview");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slides.length, navigate]);

  if (isLoading) return <Loading />;
  if (error && !data) return <Empty text={(error as Error).message} />;
  if (!data) return <Empty text="大屏暂无数据" />;

  const overdue = data.state.overdue;
  const banner = overdue.length
    ? `超时未复核：${overdue.map((item) => `${item.route}（剩余 ${item.remaining} 行，截止 ${item.deadline}）`).join("　")}`
    : data.state.due_soon.length
      ? `临近截止：${data.state.due_soon.map((item) => `${item.route}（截止 ${item.deadline}）`).join("　")}`
      : "当前无超时预警";
  const updatedLabel = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString("zh-CN", { hour12: false })
    : "";
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  };

  return (
    <>
      <div className={`screen-head${idle ? " idle" : ""}`}>
        <div className="screen-title">单量与作业进度看板</div>
        {current && (
          <div className="screen-slide">
            {current.title} · {index + 1}/{slides.length}
          </div>
        )}
        <div className={`screen-banner${overdue.length ? " danger" : data.state.due_soon.length ? " warn" : ""}`}>
          <div className="marquee">
            <span>{banner}</span>
          </div>
        </div>
        <div className="screen-right">
          <span className="screen-meta">{data.date}</span>
          <span className="screen-meta">{now}</span>
          {updatedLabel && <span className="screen-meta">更新于 {updatedLabel}</span>}
          {error && <span className="screen-alert">刷新失败</span>}
          <button className="btn btn-sm" onClick={() => { setSoundOn((prev) => !prev); if (!soundOn) beep(); }}>
            {soundOn ? "关闭声音" : "启用声音"}
          </button>
          <button className="btn btn-sm" onClick={() => setPaused((prev) => !prev)}>
            {paused ? "继续" : "暂停"}
          </button>
          <button className="btn btn-sm" onClick={toggleFullscreen}>全屏</button>
          <button className="btn btn-sm" onClick={() => navigate("/overview")}>退出</button>
        </div>
      </div>

      <div className="screen-body" id="sc-body">
        {slides.length === 0 && <Empty text="大屏还没有配置看板（在「看板总台」把看板加入大屏）" />}
        {current && (
          <div className="screen-page-host">
            <WidgetGrid
              layout={{ widgets: current.widgets }}
              date={data.date}
              rowHeight={rowHeight}
              kpiBand={false}
              fontSize={chartFontSize}
            />
          </div>
        )}
      </div>

      {slides.length > 1 && (
        <div className="screen-progress">
          <span
            key={`${index}-${paused ? "p" : "r"}`}
            className="screen-progress-bar"
            style={{
              animationDuration: `${Math.max(5, data.interval || 15)}s`,
              animationPlayState: paused ? "paused" : "running",
            }}
          />
        </div>
      )}

      <div className="screen-dots">
        {slides.map((slide, slideIndex) => (
          <span
            key={`${slide.title}-${slideIndex}`}
            className={`sc-dot${slideIndex === index ? " active" : ""}`}
            onClick={() => setIndex(slideIndex)}
            title={slide.title}
          />
        ))}
      </div>
    </>
  );
}
