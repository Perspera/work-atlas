import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { clock } from "../lib/format";
import { startEventStream, useMeta } from "../lib/hooks";
import { hasPerm, useApp } from "../lib/store";
import { Badge, Loading, Modal } from "../components/ui";
import { PAGES } from "./pages";

interface AlertRow {
  id: number;
  level: string;
  title: string;
  body?: string;
  read_at?: string | null;
  created_at?: string;
}

function BellMenu({ onClose, onViewAll }: { onClose: () => void; onViewAll: () => void }) {
  const { data, refetch, isLoading } = useQuery({
    queryKey: ["alerts", "bell"],
    queryFn: () => api<{ rows: AlertRow[]; unread?: number }>("/api/alerts", { query: { limit: 20 } }),
  });
  const toast = useApp((state) => state.toast);

  const markAll = async () => {
    try {
      await api("/api/alerts/read", { method: "POST", body: { all: true } });
      refetch();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  return (
    <div className="bell-menu" onClick={(event) => event.stopPropagation()}>
      <div className="bell-head">
        <span>预警消息</span>
        <a href="#read-all" onClick={(event) => { event.preventDefault(); void markAll(); }}>
          全部已读
        </a>
      </div>
      <div className="bell-list">
        {isLoading && <Loading text="加载中" />}
        {!isLoading && !data?.rows.length && <div className="small muted" style={{ padding: 10 }}>暂无预警消息</div>}
        {data?.rows.map((row) => (
          <div key={row.id} className={`bell-item${row.read_at ? "" : " unread"}`}>
            <div className="bell-title">
              <Badge kind={row.level === "danger" ? "danger" : "warn"}>
                {row.level === "danger" ? "超时" : "临近"}
              </Badge>{" "}
              {row.title}
            </div>
            <div className="small muted">
              {row.body || ""} · {row.created_at || ""}
            </div>
          </div>
        ))}
      </div>
      <div className="bell-foot">
        <a href="/alerts" onClick={(event) => { event.preventDefault(); onClose(); onViewAll(); }}>
          查看全部 →
        </a>
      </div>
    </div>
  );
}

function PasswordModal({ onClose }: { onClose: () => void }) {
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useApp((state) => state.toast);

  const save = async () => {
    setBusy(true);
    try {
      await api("/api/change-password", { method: "POST", body: { old_password: oldPwd, new_password: newPwd } });
      toast("密码已更新", "ok");
      onClose();
    } catch (error) {
      toast((error as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="修改密码"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>保存</button>
        </>
      }
    >
      <div className="field">
        <label>原密码</label>
        <input className="input" type="password" value={oldPwd} autoFocus
          onChange={(event) => setOldPwd(event.target.value)} />
      </div>
      <div className="field">
        <label>新密码</label>
        <input className="input" type="password" placeholder="至少 8 位，含字母和数字" value={newPwd}
          onChange={(event) => setNewPwd(event.target.value)} />
      </div>
    </Modal>
  );
}

export function Shell() {
  const me = useApp((state) => state.me);
  const date = useApp((state) => state.date);
  const setDate = useApp((state) => state.setDate);
  const online = useApp((state) => state.online);
  const lastUpdate = useApp((state) => state.lastUpdate);
  const touch = useApp((state) => state.touch);
  const meta = useMeta();
  const navigate = useNavigate();
  const [bellOpen, setBellOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);
  const initialised = useRef(false);

  // 首次拿到 meta 时把业务日期落到今天
  useEffect(() => {
    if (!meta.data) return;
    if (!initialised.current && !date) {
      initialised.current = true;
      setDate(meta.data.default_biz_date);
    }
  }, [meta.data, date, setDate]);

  useEffect(() => {
    touch(clock());
    return startEventStream();
  }, [touch]);

  useEffect(() => {
    if (!bellOpen && !menuOpen) return;
    const close = () => {
      setBellOpen(false);
      setMenuOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [bellOpen, menuOpen]);

  const unread = useQuery({
    queryKey: ["alerts", "unread"],
    queryFn: () => api<{ rows: AlertRow[]; unread?: number }>("/api/alerts", { query: { unread: 1, limit: 1 } }),
    refetchInterval: 60_000,
  });

  const logout = async () => {
    await api("/api/logout", { method: "POST" });
    window.location.assign("/");
  };

  const today = meta.data?.today || date;
  const dates = meta.data?.biz_dates || [];
  const dateLabel = (item: (typeof dates)[number]) => {
    const bits: string[] = [];
    if (item.biz_date === today || item.is_today) bits.push("今天");
    if (item.waves) bits.push(`登记 ${item.waves}`);
    if (item.archived) bits.push("已存档");
    if (!item.waves && item.data_lines) bits.push(`有数据 ${item.data_lines}`);
    return item.biz_date + (bits.length ? `（${bits.join(" · ")}）` : "");
  };

  const badge = unread.data?.unread || 0;

  return (
    <>
      <div className="topbar">
        <div className="brand">
          <span className="brand-mark">量</span>
          <span className="brand-text">{meta.data?.site_title || me?.site_title || "单量与作业进度看板"}</span>
        </div>
        <nav className="nav">
          {PAGES.filter((page) => hasPerm(me, page.perm)).map((page) => (
            <NavLink key={page.key} to={`/${page.key}`} className={({ isActive }) => (isActive ? "active" : "")}>
              {page.title}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-right">
          <select
            className="select"
            style={{ height: 30, minWidth: 150 }}
            value={date}
            onChange={(event) => setDate(event.target.value)}
          >
            {dates.length === 0 && <option value={date}>{date}</option>}
            {dates.map((item) => (
              <option key={item.biz_date} value={item.biz_date}>
                {dateLabel(item)}
              </option>
            ))}
          </select>
          {date && today && date !== today && (
            <button className="btn btn-sm" style={{ height: 26 }} onClick={() => setDate(today)}>
              回到今天
            </button>
          )}
          {hasPerm(me, "page.screen") && (
            <button className="btn btn-sm" style={{ height: 26 }} onClick={() => navigate("/screen")}>
              大屏
            </button>
          )}
          {hasPerm(me, "page.alerts") && (
            <button
              className="btn btn-sm"
              style={{ height: 26, position: "relative" }}
              title="预警消息"
              aria-label="预警消息"
              onClick={(event) => {
                event.stopPropagation();
                setBellOpen((open) => !open);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 2a3.5 3.5 0 0 0-3.5 3.5c0 3-1.5 4-1.5 4h10s-1.5-1-1.5-4A3.5 3.5 0 0 0 8 2Z" />
                <path d="M6.6 12.5a1.5 1.5 0 0 0 2.8 0" />
              </svg>
              {badge > 0 && <span className="bell-dot">{badge > 99 ? "99+" : badge}</span>}
            </button>
          )}
          <span className="meta">
            <span className={`dot${online ? "" : " off"}`} /> {lastUpdate || "--:--:--"}
          </span>
          <div
            className="user-chip"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen((open) => !open);
            }}
          >
            {me?.user?.display_name || me?.user?.username || ""}
          </div>
        </div>
      </div>

      <div className="page">
        <Outlet />
      </div>

      {bellOpen && <BellMenu onClose={() => setBellOpen(false)} onViewAll={() => navigate("/alerts")} />}
      {menuOpen && (
        <div className="menu" onClick={(event) => event.stopPropagation()}>
          <div style={{ padding: "6px 10px 8px", color: "#7b8794", fontSize: 12 }}>
            {me?.user?.display_name || ""}
            {me?.scopes && Object.keys(me.scopes).length > 0 && (
              <>
                <br />
                数据范围：{JSON.stringify(me.scopes)}
              </>
            )}
          </div>
          <div className="sep" />
          <button
            onClick={() => {
              setMenuOpen(false);
              setPwdOpen(true);
            }}
          >
            修改密码
          </button>
          <button onClick={logout}>退出登录</button>
        </div>
      )}
      {pwdOpen && <PasswordModal onClose={() => setPwdOpen(false)} />}
    </>
  );
}
