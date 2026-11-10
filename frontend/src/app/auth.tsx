import { useState } from "react";

import { api } from "../lib/api";
import type { Me } from "../lib/types";

function AuthShell({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-title">{title}</div>
        <div className="auth-sub">{sub}</div>
        {children}
        <div className="auth-foot">局域网内部系统 · 请使用管理员分配的账号</div>
      </div>
    </div>
  );
}

function ErrorText({ text }: { text: string }) {
  if (!text) return null;
  return <div className="auth-err" style={{ display: "block" }}>{text}</div>;
}

export function LoginPage({ siteTitle, onDone }: { siteTitle?: string; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      await api<Me>("/api/login", { method: "POST", body: { username: username.trim(), password } });
      onDone();
    } catch (error) {
      setErr((error as Error).message || "登录失败，请重试");
      setBusy(false);
    }
  };

  return (
    <AuthShell title={siteTitle || "单量与作业进度看板"} sub="请登录后查看">
      <ErrorText text={err} />
      <div className="field">
        <label>账号</label>
        <input
          className="input"
          autoComplete="username"
          value={username}
          autoFocus
          onChange={(event) => setUsername(event.target.value)}
        />
      </div>
      <div className="field">
        <label>密码</label>
        <input
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && submit()}
        />
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={submit}>
        {busy ? "登录中…" : "登录"}
      </button>
    </AuthShell>
  );
}

export function SetupPage({ siteTitle, onDone }: { siteTitle?: string; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [display, setDisplay] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (password !== confirm) {
      setErr("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      await api<Me>("/api/setup", {
        method: "POST",
        body: { username: username.trim(), display_name: display.trim(), password },
      });
      onDone();
    } catch (error) {
      setErr((error as Error).message);
      setBusy(false);
    }
  };

  return (
    <AuthShell title={siteTitle || "单量与作业进度看板"} sub="首次启动：创建管理员账号">
      <ErrorText text={err} />
      <div className="field">
        <label>管理员账号</label>
        <input className="input" autoComplete="username" placeholder="3-32 位字母数字"
          value={username} autoFocus onChange={(event) => setUsername(event.target.value)} />
      </div>
      <div className="field">
        <label>显示名称</label>
        <input className="input" placeholder="如：张三" value={display}
          onChange={(event) => setDisplay(event.target.value)} />
      </div>
      <div className="field">
        <label>密码</label>
        <input className="input" type="password" autoComplete="new-password"
          placeholder="至少 8 位，含字母和数字" value={password}
          onChange={(event) => setPassword(event.target.value)} />
      </div>
      <div className="field">
        <label>确认密码</label>
        <input className="input" type="password" autoComplete="new-password" value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && submit()} />
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={submit}>
        {busy ? "创建中…" : "创建管理员并开始使用"}
      </button>
    </AuthShell>
  );
}

/** forced=true：默认口令未修改时拦截整个系统，不可取消。 */
export function ChangePasswordPage({ forced, siteTitle, onDone }: { forced: boolean; siteTitle?: string; onDone: () => void }) {
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      await api("/api/change-password", {
        method: "POST",
        body: { old_password: oldPwd, new_password: newPwd },
      });
      onDone();
    } catch (error) {
      setErr((error as Error).message);
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title={siteTitle || "单量与作业进度看板"}
      sub={forced ? "首次登录，请修改初始密码" : "修改密码"}
    >
      <ErrorText text={err} />
      <div className="field">
        <label>原密码</label>
        <input className="input" type="password" value={oldPwd} autoFocus
          onChange={(event) => setOldPwd(event.target.value)} />
      </div>
      <div className="field">
        <label>新密码</label>
        <input className="input" type="password" placeholder="至少 8 位，含字母和数字" value={newPwd}
          onChange={(event) => setNewPwd(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && submit()} />
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={submit}>
        {busy ? "提交中…" : "设置新密码"}
      </button>
    </AuthShell>
  );
}
