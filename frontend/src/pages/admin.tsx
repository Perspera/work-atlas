import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { num } from "../lib/format";
import { useApp } from "../lib/store";
import { Badge, Empty, Kpi, KpiBand, Loading, Modal, PageHead, Panel, Seg } from "../components/ui";

interface GroupLite {
  id: number;
  name: string;
}

interface GroupRow {
  id: number;
  name: string;
  description: string | null;
  members: number[];
  allow: string[];
  deny: string[];
  scopes: Record<string, string[]>;
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  status: string;
  must_change_pwd: boolean;
  last_login_at: string | null;
  created_at: string | null;
  groups: GroupLite[];
  permissions: string[];
}

interface PermDef {
  code: string;
  group: string;
  title: string;
  description: string;
}

interface PermUser {
  id: number;
  display_name: string;
  username: string;
  allow: string[];
  deny: string[];
  scopes: Record<string, string[]>;
}

interface PermissionsData {
  permissions: PermDef[];
  groups: GroupRow[];
  users: PermUser[];
  scope_dims: Record<string, string>;
}

type PermValue = "" | "allow" | "deny";

const TABS = [
  { key: "users", label: "用户" },
  { key: "groups", label: "用户组" },
  { key: "permissions", label: "权限矩阵" },
  { key: "scopes", label: "数据范围" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const SCOPE_DIMS = [
  { key: "region", label: "区域" },
  { key: "route", label: "承运商/线路" },
  { key: "zone", label: "库区" },
  { key: "doc_type", label: "单据类型" },
  { key: "waves", label: "波次(own=本人)" },
] as const;

function randomPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 10; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return `${out}8a`;
}

function permState(perms: PermDef[], allow: string[], deny: string[]): Record<string, PermValue> {
  const state: Record<string, PermValue> = {};
  perms.forEach((perm) => {
    state[perm.code] = allow.includes(perm.code) ? "allow" : deny.includes(perm.code) ? "deny" : "";
  });
  return state;
}

function collectPerms(state: Record<string, PermValue>) {
  const allow: string[] = [];
  const deny: string[] = [];
  Object.entries(state).forEach(([code, value]) => {
    if (value === "allow") allow.push(code);
    if (value === "deny") deny.push(code);
  });
  return { allow, deny };
}

function PermMatrix({
  perms,
  value,
  onChange,
}: {
  perms: PermDef[];
  value: Record<string, PermValue>;
  onChange: (code: string, next: PermValue) => void;
}) {
  const grouped = new Map<string, PermDef[]>();
  perms.forEach((perm) => {
    const list = grouped.get(perm.group) || [];
    list.push(perm);
    grouped.set(perm.group, list);
  });
  return (
    <>
      {Array.from(grouped.entries()).map(([group, list]) => (
        <div key={group} style={{ marginBottom: 12 }}>
          <div className="panel-sub" style={{ marginBottom: 6 }}>{group}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "4px 14px" }}>
            {list.map((perm) => (
              <label key={perm.code} className="check" title={perm.description || ""}>
                <select
                  className="select"
                  style={{ height: 26, padding: "0 6px", borderRadius: 6 }}
                  value={value[perm.code] || ""}
                  onChange={(event) => onChange(perm.code, event.target.value as PermValue)}
                >
                  <option value="">继承</option>
                  <option value="allow">允许</option>
                  <option value="deny">拒绝</option>
                </select>
                <span>{perm.title}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function UserModal({
  user,
  groups,
  perms,
  onClose,
  onSaved,
}: {
  user: UserRow | null;
  groups: GroupLite[];
  perms: PermDef[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useApp((state) => state.toast);
  const isNew = !user;
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState(user?.display_name || "");
  const [password, setPassword] = useState(() => randomPassword());
  const [role, setRole] = useState("viewer");
  const [status, setStatus] = useState(user && user.status !== "active" ? "disabled" : "active");
  const [groupIds, setGroupIds] = useState<number[]>(() => (user ? user.groups.map((group) => group.id) : []));
  const [permValues, setPermValues] = useState<Record<string, PermValue>>(() =>
    permState(perms, user ? user.permissions : [], []),
  );
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const { allow, deny } = collectPerms(permValues);
    try {
      if (user) {
        await api(`/api/users/${user.id}`, {
          method: "PUT",
          body: {
            display_name: displayName.trim(),
            status,
            groups: groupIds,
            allow,
            deny,
          },
        });
        toast("已保存", "ok");
      } else {
        const created = await api<{ id: number }>("/api/users", {
          method: "POST",
          body: {
            username: username.trim(),
            display_name: displayName.trim(),
            password,
            role,
            groups: groupIds,
          },
        });
        await api(`/api/users/${created.id}`, {
          method: "PUT",
          body: { allow, deny, groups: groupIds },
        });
        toast("用户已创建", "ok");
      }
      onSaved();
    } catch (error) {
      toast((error as Error).message, "err");
      setBusy(false);
    }
  };

  return (
    <Modal
      title={user ? `编辑用户 — ${user.display_name}` : "新建用户"}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{isNew ? "创建" : "保存"}</button>
        </>
      }
    >
      {isNew ? (
        <>
          <div className="grid cols-2">
            <div className="field">
              <label>账号</label>
              <input className="input" value={username} onChange={(event) => setUsername(event.target.value)} />
            </div>
            <div className="field">
              <label>显示名称</label>
              <input className="input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            </div>
          </div>
          <div className="grid cols-2">
            <div className="field">
              <label>初始密码</label>
              <input className="input" value={password} onChange={(event) => setPassword(event.target.value)} />
            </div>
            <div className="field">
              <label>初始角色</label>
              <select className="select" value={role} onChange={(event) => setRole(event.target.value)}>
                <option value="viewer">只读</option>
                <option value="editor">登记员</option>
                <option value="admin">管理员</option>
              </select>
            </div>
          </div>
        </>
      ) : (
        <div className="grid cols-2">
          <div className="field">
            <label>显示名称</label>
            <input className="input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </div>
          <div className="field">
            <label>状态</label>
            <select className="select" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="active">启用</option>
              <option value="disabled">停用</option>
            </select>
          </div>
        </div>
      )}
      <div className="field">
        <label>所属用户组</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {groups.length ? groups.map((group) => (
            <label key={group.id} className="check">
              <input
                type="checkbox"
                checked={groupIds.includes(group.id)}
                onChange={(event) =>
                  setGroupIds((prev) =>
                    event.target.checked ? [...prev, group.id] : prev.filter((id) => id !== group.id),
                  )
                }
              />
              {group.name}
            </label>
          )) : <span className="muted small">还没有用户组</span>}
        </div>
      </div>
      <div className="field">
        <label>权限点（逐项：继承 / 允许 / 拒绝）</label>
        <div style={{ maxHeight: 320, overflow: "auto", border: "1px solid #e6e9ef", borderRadius: 8, padding: 10 }}>
          <PermMatrix
            perms={perms}
            value={permValues}
            onChange={(code, next) => setPermValues((prev) => ({ ...prev, [code]: next }))}
          />
        </div>
      </div>
    </Modal>
  );
}

function ResetPasswordModal({
  user,
  onClose,
  onSaved,
}: {
  user: UserRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useApp((state) => state.toast);
  const [password, setPassword] = useState(() => randomPassword());
  const [busy, setBusy] = useState(false);

  const reset = async () => {
    setBusy(true);
    try {
      await api(`/api/users/${user.id}/reset`, { method: "POST", body: { password } });
      toast("密码已重置", "ok");
      onSaved();
    } catch (error) {
      toast((error as Error).message, "err");
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`重置密码 — ${user.display_name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy} onClick={reset}>重置</button>
        </>
      }
    >
      <div className="field">
        <label>临时密码</label>
        <input className="input" value={password} onChange={(event) => setPassword(event.target.value)} />
      </div>
      <div className="small muted">用户下次登录会被强制修改密码。</div>
    </Modal>
  );
}

function GroupModal({
  group,
  users,
  perms,
  onClose,
  onSaved,
}: {
  group: GroupRow | null;
  users: UserRow[];
  perms: PermDef[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useApp((state) => state.toast);
  const isNew = !group;
  const [name, setName] = useState(group?.name || "");
  const [description, setDescription] = useState(group?.description || "");
  const [members, setMembers] = useState<number[]>(() => (group ? group.members : []));
  const [permValues, setPermValues] = useState<Record<string, PermValue>>(() =>
    permState(perms, group ? group.allow : [], group ? group.deny : []),
  );
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const { allow, deny } = collectPerms(permValues);
    const payload = {
      name: name.trim(),
      description: description.trim(),
      members,
      allow,
      deny,
    };
    try {
      if (group) {
        await api(`/api/groups/${group.id}`, { method: "PUT", body: payload });
      } else {
        const created = await api<{ id: number }>("/api/groups", { method: "POST", body: payload });
        if (created.id) {
          await api(`/api/groups/${created.id}`, { method: "PUT", body: payload });
        }
      }
      toast("已保存", "ok");
      onSaved();
    } catch (error) {
      toast((error as Error).message, "err");
      setBusy(false);
    }
  };

  return (
    <Modal
      title={group ? `编辑用户组 — ${group.name}` : "新建用户组"}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{isNew ? "创建" : "保存"}</button>
        </>
      }
    >
      <div className="grid cols-2">
        <div className="field">
          <label>组名</label>
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="field">
          <label>说明</label>
          <input className="input" value={description} onChange={(event) => setDescription(event.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>成员</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {users.map((user) => (
            <label key={user.id} className="check">
              <input
                type="checkbox"
                checked={members.includes(user.id)}
                onChange={(event) =>
                  setMembers((prev) =>
                    event.target.checked ? [...prev, user.id] : prev.filter((id) => id !== user.id),
                  )
                }
              />
              {user.display_name}
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <label>权限点</label>
        <div style={{ maxHeight: 320, overflow: "auto", border: "1px solid #e6e9ef", borderRadius: 8, padding: 10 }}>
          <PermMatrix
            perms={perms}
            value={permValues}
            onChange={(code, next) => setPermValues((prev) => ({ ...prev, [code]: next }))}
          />
        </div>
      </div>
    </Modal>
  );
}

function GroupPermissionModal({
  group,
  perms,
  onClose,
  onSaved,
}: {
  group: GroupRow;
  perms: PermDef[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useApp((state) => state.toast);
  const [permValues, setPermValues] = useState<Record<string, PermValue>>(() =>
    permState(perms, group.allow, group.deny),
  );
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const payload = collectPerms(permValues);
      await api(`/api/permissions/group/${group.id}`, { method: "PUT", body: payload });
      toast("权限已保存", "ok");
      onSaved();
    } catch (error) {
      toast((error as Error).message, "err");
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`配置权限 — ${group.name}`}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>保存</button>
        </>
      }
    >
      <div style={{ maxHeight: "60vh", overflow: "auto" }}>
        <PermMatrix
          perms={perms}
          value={permValues}
          onChange={(code, next) => setPermValues((prev) => ({ ...prev, [code]: next }))}
        />
      </div>
    </Modal>
  );
}

interface ScopeOwner {
  type: "user" | "group";
  id: number;
  label: string;
  scopes: Record<string, string[]>;
}

function scopeDraft(owner?: ScopeOwner): Record<string, string> {
  const draft: Record<string, string> = {};
  SCOPE_DIMS.forEach((dim) => {
    draft[dim.key] = (owner?.scopes?.[dim.key] || []).join(",");
  });
  return draft;
}

function ScopesPanel({
  users,
  groups,
  onSaved,
}: {
  users: PermUser[];
  groups: GroupRow[];
  onSaved: () => void;
}) {
  const toast = useApp((state) => state.toast);
  const owners: ScopeOwner[] = [
    ...users.map((user) => ({
      type: "user" as const,
      id: user.id,
      label: `用户：${user.display_name}`,
      scopes: user.scopes || {},
    })),
    ...groups.map((group) => ({
      type: "group" as const,
      id: group.id,
      label: `用户组：${group.name}`,
      scopes: group.scopes || {},
    })),
  ];
  const [ownerKey, setOwnerKey] = useState(() => (owners[0] ? `${owners[0].type}:${owners[0].id}` : ""));
  const [draft, setDraft] = useState<Record<string, string>>(() => scopeDraft(owners[0]));
  const [busy, setBusy] = useState(false);
  const current = owners.find((owner) => `${owner.type}:${owner.id}` === ownerKey);

  const save = async () => {
    if (!current) return;
    setBusy(true);
    const scopes: Record<string, string[]> = {};
    SCOPE_DIMS.forEach((dim) => {
      const values = (draft[dim.key] || "").trim().split(/[,，\s]+/).filter(Boolean);
      if (values.length) scopes[dim.key] = values;
    });
    try {
      await api(`/api/scopes/${current.type}/${current.id}`, { method: "PUT", body: { scopes } });
      toast("数据范围已保存", "ok");
      onSaved();
    } catch (error) {
      toast((error as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  if (!owners.length) {
    return (
      <Panel title="数据范围（行级过滤）">
        <Empty text="还没有用户或用户组" />
      </Panel>
    );
  }

  return (
    <Panel title="数据范围（行级过滤）">
      <div className="field" style={{ maxWidth: 420 }}>
        <label>选择用户或用户组</label>
        <select
          className="select"
          value={ownerKey}
          onChange={(event) => {
            const next = event.target.value;
            setOwnerKey(next);
            setDraft(scopeDraft(owners.find((owner) => `${owner.type}:${owner.id}` === next)));
          }}
        >
          {owners.map((owner) => (
            <option key={`${owner.type}:${owner.id}`} value={`${owner.type}:${owner.id}`}>
              {owner.label}
            </option>
          ))}
        </select>
      </div>
      <div className="grid cols-2">
        {SCOPE_DIMS.map((dim) => (
          <div key={dim.key} className="field">
            <label>{dim.label}</label>
            <input
              className="input"
              value={draft[dim.key] || ""}
              placeholder="多个用逗号分隔，留空不限"
              onChange={(event) => setDraft((prev) => ({ ...prev, [dim.key]: event.target.value }))}
            />
          </div>
        ))}
      </div>
      <div className="small muted">多个来源取并集；留空表示不限。填「own」表示只看本人登记的波次。</div>
      <div style={{ marginTop: 12 }}>
        <button className="btn btn-primary" disabled={busy} onClick={save}>保存数据范围</button>
      </div>
    </Panel>
  );
}

export default function AdminPage() {
  const toast = useApp((state) => state.toast);
  const [tab, setTab] = useState<TabKey>("users");
  const [editingUser, setEditingUser] = useState<{ user: UserRow | null } | null>(null);
  const [resetUser, setResetUser] = useState<UserRow | null>(null);
  const [editingGroup, setEditingGroup] = useState<{ group: GroupRow | null } | null>(null);
  const [permGroup, setPermGroup] = useState<GroupRow | null>(null);

  const usersQuery = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => api<{ rows: UserRow[]; groups: GroupLite[] }>("/api/users"),
  });
  const groupsQuery = useQuery({
    queryKey: ["admin", "groups"],
    queryFn: () => api<{ rows: GroupRow[] }>("/api/groups"),
  });
  const permsQuery = useQuery({
    queryKey: ["admin", "permissions"],
    queryFn: () => api<PermissionsData>("/api/permissions"),
  });

  const perms = permsQuery.data?.permissions || [];
  const users = usersQuery.data?.rows || [];
  const groups = groupsQuery.data?.rows || [];

  const refreshUsers = () => {
    void usersQuery.refetch();
    void groupsQuery.refetch();
    void permsQuery.refetch();
  };
  const refreshGroups = () => {
    void groupsQuery.refetch();
    void usersQuery.refetch();
    void permsQuery.refetch();
  };
  const refreshPermissions = () => {
    void permsQuery.refetch();
    void groupsQuery.refetch();
  };

  const removeGroup = async (group: GroupRow) => {
    if (!window.confirm("删除后该组成员会失去通过本组获得的权限。确定？")) return;
    try {
      await api(`/api/groups/${group.id}`, { method: "DELETE" });
      toast("已删除", "ok");
      refreshGroups();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  const renderUsers = () => {
    if (usersQuery.isLoading || permsQuery.isLoading) return <Loading />;
    if (usersQuery.error) return <Empty text={(usersQuery.error as Error).message} />;
    if (permsQuery.error) return <Empty text={(permsQuery.error as Error).message} />;
    return (
      <Panel
        title={`用户（${users.length}）`}
        actions={
          <button className="btn btn-primary btn-sm" onClick={() => setEditingUser({ user: null })}>
            新建用户
          </button>
        }
        flush
      >
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>用户</th>
                <th>用户组</th>
                <th className="num">权限数</th>
                <th>状态</th>
                <th>最后登录</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-cell"><Empty text="暂无数据" /></td>
                </tr>
              )}
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <b>{user.display_name}</b>
                    <div className="small muted">{user.username}</div>
                  </td>
                  <td>
                    {(user.groups || []).map((group) => (
                      <span key={group.id}><Badge>{group.name}</Badge> </span>
                    ))}
                  </td>
                  <td className="num">{(user.permissions || []).length}</td>
                  <td>
                    {user.status === "active" ? <Badge kind="ok">启用</Badge> : <Badge kind="danger">停用</Badge>}
                  </td>
                  <td className="small muted">{user.last_login_at || "-"}</td>
                  <td className="nowrap">
                    <button className="btn btn-sm btn-ghost" onClick={() => setEditingUser({ user })}>编辑</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => setResetUser(user)}>重置密码</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    );
  };

  const renderGroups = () => {
    if (groupsQuery.isLoading || permsQuery.isLoading) return <Loading />;
    if (groupsQuery.error) return <Empty text={(groupsQuery.error as Error).message} />;
    return (
      <Panel
        title={`用户组（${groups.length}）`}
        actions={
          <button className="btn btn-primary btn-sm" onClick={() => setEditingGroup({ group: null })}>
            新建用户组
          </button>
        }
        flush
      >
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>组名</th>
                <th className="num">成员</th>
                <th className="num">允许权限</th>
                <th className="num">拒绝权限</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {groups.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty-cell"><Empty text="暂无数据" /></td>
                </tr>
              )}
              {groups.map((group) => (
                <tr key={group.id}>
                  <td>
                    <b>{group.name}</b>
                    <div className="small muted">{group.description || ""}</div>
                  </td>
                  <td className="num">{(group.members || []).length}</td>
                  <td className="num">{(group.allow || []).length}</td>
                  <td className="num">{(group.deny || []).length}</td>
                  <td className="nowrap">
                    <button className="btn btn-sm btn-ghost" onClick={() => setEditingGroup({ group })}>编辑</button>
                    <button className="btn btn-sm btn-danger" onClick={() => void removeGroup(group)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    );
  };

  const renderPermissions = () => {
    if (groupsQuery.isLoading || permsQuery.isLoading) return <Loading />;
    if (groupsQuery.error) return <Empty text={(groupsQuery.error as Error).message} />;
    if (permsQuery.error) return <Empty text={(permsQuery.error as Error).message} />;
    return (
      <>
        <Panel
          title="按用户组授权"
          sub={`权限点共 ${perms.length} 项，可逐项设置为允许/拒绝/继承`}
          flush
        >
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>用户组</th>
                  <th className="num">成员</th>
                  <th className="num">允许</th>
                  <th className="num">拒绝</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {groups.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty-cell"><Empty text="还没有用户组" /></td>
                  </tr>
                )}
                {groups.map((group) => (
                  <tr key={group.id}>
                    <td><b>{group.name}</b></td>
                    <td className="num">{(group.members || []).length}</td>
                    <td className="num">{(group.allow || []).length}</td>
                    <td className="num">{(group.deny || []).length}</td>
                    <td>
                      <button className="btn btn-sm btn-ghost" onClick={() => setPermGroup(group)}>配置权限</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <div style={{ marginTop: 14 }}>
          <Panel title="权限点清单" flush>
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>分组</th>
                    <th>权限点</th>
                    <th>代码</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {perms.map((perm) => (
                    <tr key={perm.code}>
                      <td>{perm.group}</td>
                      <td>{perm.title}</td>
                      <td className="mono small">{perm.code}</td>
                      <td className="small muted">{perm.description || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      </>
    );
  };

  const renderScopes = () => {
    if (permsQuery.isLoading) return <Loading />;
    if (permsQuery.error) return <Empty text={(permsQuery.error as Error).message} />;
    return (
      <ScopesPanel
        users={permsQuery.data?.users || []}
        groups={permsQuery.data?.groups || []}
        onSaved={() => void permsQuery.refetch()}
      />
    );
  };

  return (
    <>
      <PageHead title="用户与权限" sub="逐项授权：用户组 × 页面/组件/动作/字段 × 数据范围">
        <Seg items={TABS.map((item) => ({ key: item.key, label: item.label }))} value={tab} onChange={setTab} />
      </PageHead>

      {(permsQuery.data || usersQuery.data || groupsQuery.data) && (
        <KpiBand cols={4}>
          <Kpi label="用户" value={num(users.length)} unit="个"
            sub={`启用 ${num(users.filter((item) => item.status === "active").length)} · 待改密 ${num(users.filter((item) => item.must_change_pwd).length)}`} />
          <Kpi label="用户组" value={num(groups.length)} unit="个"
            sub={groups.map((item) => item.name).join(" / ") || "—"} />
          <Kpi label="权限项" value={num(perms.length)} unit="项"
            sub={`页面 ${num(perms.filter((item) => item.group === "页面").length)} / 动作 ${num(perms.filter((item) => item.group === "动作").length)} / 字段 ${num(perms.filter((item) => item.group === "字段").length)}`} />
          <Kpi label="数据范围" value={num(Object.keys(permsQuery.data?.scope_dims || {}).length)} unit="维"
            sub={Object.values(permsQuery.data?.scope_dims || {}).join(" / ") || "—"} />
        </KpiBand>
      )}

      {tab === "users" && renderUsers()}
      {tab === "groups" && renderGroups()}
      {tab === "permissions" && renderPermissions()}
      {tab === "scopes" && renderScopes()}

      {editingUser && (
        <UserModal
          user={editingUser.user}
          groups={usersQuery.data?.groups || []}
          perms={perms}
          onClose={() => setEditingUser(null)}
          onSaved={() => {
            setEditingUser(null);
            refreshUsers();
          }}
        />
      )}
      {resetUser && (
        <ResetPasswordModal
          user={resetUser}
          onClose={() => setResetUser(null)}
          onSaved={() => {
            setResetUser(null);
            void usersQuery.refetch();
          }}
        />
      )}
      {editingGroup && (
        <GroupModal
          group={editingGroup.group}
          users={users}
          perms={perms}
          onClose={() => setEditingGroup(null)}
          onSaved={() => {
            setEditingGroup(null);
            refreshGroups();
          }}
        />
      )}
      {permGroup && (
        <GroupPermissionModal
          group={permGroup}
          perms={perms}
          onClose={() => setPermGroup(null)}
          onSaved={() => {
            setPermGroup(null);
            refreshPermissions();
          }}
        />
      )}
    </>
  );
}
