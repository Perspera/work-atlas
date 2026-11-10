# -*- coding: utf-8 -*-
"""用户、用户组、权限、数据范围与审计"""

import auth
import db
import json
import perms
import re

from api.runtime import ApiError


class AdminMixin:

    def api_users(self, _match, _query):
        self.require("action.users.manage")
        rows = self.conn.execute("SELECT * FROM users ORDER BY id").fetchall()
        groups = {}
        for r in self.conn.execute(
            "SELECT gm.user_id, g.id, g.name FROM group_members gm JOIN groups g ON g.id=gm.group_id"
        ):
            groups.setdefault(r["user_id"], []).append({"id": r["id"], "name": r["name"]})
        result = []
        for r in rows:
            result.append(
                {
                    "id": r["id"],
                    "username": r["username"],
                    "display_name": r["display_name"],
                    "status": r["status"],
                    "must_change_pwd": bool(r["must_change_pwd"]),
                    "last_login_at": r["last_login_at"],
                    "created_at": r["created_at"],
                    "groups": groups.get(r["id"], []),
                    "permissions": sorted(auth.effective_permissions(self.conn, r["id"])),
                }
            )
        self.json_out({"rows": result, "groups": self._groups_payload()})

    def api_user_create(self, _match, _query):
        self.require("action.users.manage")
        body = self.read_json()
        username = (body.get("username") or "").strip()
        if not re.match(r"^[A-Za-z0-9_.-]{3,32}$", username):
            raise ApiError(400, "用户名 3-32 位，仅字母数字下划线")
        if auth.get_user_by_username(self.conn, username):
            raise ApiError(400, "用户名已存在")
        password = body.get("password") or ""
        problem = auth.password_problem(password)
        if problem:
            raise ApiError(400, problem)
        role = body.get("role") or "viewer"
        uid = auth.create_user(
            self.conn, username, (body.get("display_name") or username).strip(),
            password, role=role, must_change=1,
        )
        for gid in body.get("groups") or []:
            self.conn.execute(
                "INSERT OR IGNORE INTO group_members(group_id, user_id) VALUES(?,?)", (int(gid), uid)
            )
        db.audit(self.conn, self.user, self.client_ip(), "user.create", username, "role=" + role)
        self.json_out({"ok": True, "id": uid})

    def api_user_update(self, match, _query):
        self.require("action.users.manage")
        uid = int(match.group(1))
        user = auth.get_user(self.conn, uid)
        if not user:
            raise ApiError(404, "用户不存在")
        body = self.read_json()
        if body.get("display_name") is not None:
            self.conn.execute(
                "UPDATE users SET display_name=? WHERE id=?",
                ((body["display_name"] or "").strip() or user["username"], uid),
            )
        if body.get("status") in ("active", "disabled"):
            if uid == self.user["id"] and body["status"] == "disabled":
                raise ApiError(400, "不能停用自己")
            self.conn.execute("UPDATE users SET status=? WHERE id=?", (body["status"], uid))
        if body.get("groups") is not None:
            self.conn.execute("DELETE FROM group_members WHERE user_id=?", (uid,))
            for gid in body["groups"]:
                self.conn.execute(
                    "INSERT OR IGNORE INTO group_members(group_id, user_id) VALUES(?,?)", (int(gid), uid)
                )
        if body.get("allow") is not None or body.get("deny") is not None:
            self.conn.execute("DELETE FROM user_permissions WHERE user_id=?", (uid,))
            for code in body.get("allow") or []:
                if code in perms.PERM_CODES:
                    self.conn.execute(
                        "INSERT INTO user_permissions(user_id, perm_code, effect) VALUES(?,?,'allow')",
                        (uid, code),
                    )
            for code in body.get("deny") or []:
                if code in perms.PERM_CODES:
                    self.conn.execute(
                        "INSERT INTO user_permissions(user_id, perm_code, effect) VALUES(?,?,'deny')",
                        (uid, code),
                    )
        db.bump_version(self.conn)
        db.audit(self.conn, self.user, self.client_ip(), "user.update", user["username"],
                 json.dumps(body, ensure_ascii=False))
        self.json_out({"ok": True})

    def api_user_reset(self, match, _query):
        self.require("action.users.resetpwd")
        uid = int(match.group(1))
        user = auth.get_user(self.conn, uid)
        if not user:
            raise ApiError(404, "用户不存在")
        body = self.read_json()
        password = body.get("password") or ""
        problem = auth.password_problem(password)
        if problem:
            raise ApiError(400, problem)
        auth.set_password(self.conn, uid, password, must_change=1)
        db.audit(self.conn, self.user, self.client_ip(), "user.resetpwd", user["username"], "")
        self.json_out({"ok": True, "temp_password": password})

    def api_groups(self, _match, _query):
        self.require("action.users.manage")
        self.json_out({"rows": self._groups_payload()})

    def api_group_create(self, _match, _query):
        self.require("action.users.manage")
        body = self.read_json()
        name = (body.get("name") or "").strip()
        if not name:
            raise ApiError(400, "组名不能为空")
        try:
            cur = self.conn.execute(
                "INSERT INTO groups(name, description) VALUES(?,?)",
                (name, (body.get("description") or "").strip() or None),
            )
        except Exception:
            raise ApiError(400, "组名已存在")
        db.audit(self.conn, self.user, self.client_ip(), "group.create", name, "")
        self.json_out({"ok": True, "id": cur.lastrowid})

    def api_group_update(self, match, _query):
        self.require("action.users.manage")
        gid = int(match.group(1))
        row = self.conn.execute("SELECT * FROM groups WHERE id=?", (gid,)).fetchone()
        if not row:
            raise ApiError(404, "组不存在")
        body = self.read_json()
        if body.get("name") is not None:
            self.conn.execute(
                "UPDATE groups SET name=?, description=? WHERE id=?",
                ((body["name"] or row["name"]).strip(), (body.get("description") or row["description"]), gid),
            )
        if body.get("members") is not None:
            self.conn.execute("DELETE FROM group_members WHERE group_id=?", (gid,))
            for uid in body["members"]:
                self.conn.execute(
                    "INSERT OR IGNORE INTO group_members(group_id, user_id) VALUES(?,?)", (gid, int(uid))
                )
        if body.get("allow") is not None or body.get("deny") is not None:
            self.conn.execute("DELETE FROM group_permissions WHERE group_id=?", (gid,))
            for code in body.get("allow") or []:
                if code in perms.PERM_CODES:
                    self.conn.execute(
                        "INSERT INTO group_permissions(group_id, perm_code, effect) VALUES(?,?,'allow')",
                        (gid, code),
                    )
            for code in body.get("deny") or []:
                if code in perms.PERM_CODES:
                    self.conn.execute(
                        "INSERT INTO group_permissions(group_id, perm_code, effect) VALUES(?,?,'deny')",
                        (gid, code),
                    )
        db.bump_version(self.conn)
        db.audit(self.conn, self.user, self.client_ip(), "group.update", row["name"], json.dumps(body, ensure_ascii=False))
        self.json_out({"ok": True})

    def api_group_delete(self, match, _query):
        self.require("action.users.manage")
        gid = int(match.group(1))
        row = self.conn.execute("SELECT * FROM groups WHERE id=?", (gid,)).fetchone()
        if not row:
            raise ApiError(404, "组不存在")
        self.conn.execute("DELETE FROM group_members WHERE group_id=?", (gid,))
        self.conn.execute("DELETE FROM group_permissions WHERE group_id=?", (gid,))
        self.conn.execute("DELETE FROM data_scopes WHERE owner_type='group' AND owner_id=?", (gid,))
        self.conn.execute("DELETE FROM groups WHERE id=?", (gid,))
        db.audit(self.conn, self.user, self.client_ip(), "group.delete", row["name"], "")
        self.json_out({"ok": True})

    def api_permissions(self, _match, _query):
        self.require("action.users.manage")
        self.json_out(
            {
                "permissions": [
                    {"code": code, "group": group, "title": title, "description": description}
                    for code, group, title, description in perms.PERMISSIONS
                ],
                "presets": {role: sorted(codes) for role, codes in perms.PRESETS.items()},
                "roles": perms.ROLE_TITLES,
                "scope_dims": perms.SCOPE_DIMS,
                "groups": self._groups_payload(),
                "users": [
                    {
                        "id": r["id"],
                        "display_name": r["display_name"],
                        "username": r["username"],
                        "allow": [
                            x["perm_code"]
                            for x in self.conn.execute(
                                "SELECT perm_code FROM user_permissions WHERE user_id=? AND effect='allow'",
                                (r["id"],),
                            )
                        ],
                        "deny": [
                            x["perm_code"]
                            for x in self.conn.execute(
                                "SELECT perm_code FROM user_permissions WHERE user_id=? AND effect='deny'",
                                (r["id"],),
                            )
                        ],
                        "scopes": auth.scope_summary(self.conn, r["id"]),
                    }
                    for r in self.conn.execute("SELECT * FROM users ORDER BY id")
                ],
            }
        )

    def api_permission_group(self, match, _query):
        self.require("action.users.manage")
        gid = int(match.group(1))
        body = self.read_json()
        self.conn.execute("DELETE FROM group_permissions WHERE group_id=?", (gid,))
        for code in body.get("allow") or []:
            if code in perms.PERM_CODES:
                self.conn.execute(
                    "INSERT INTO group_permissions(group_id, perm_code, effect) VALUES(?,?,'allow')", (gid, code)
                )
        for code in body.get("deny") or []:
            if code in perms.PERM_CODES:
                self.conn.execute(
                    "INSERT INTO group_permissions(group_id, perm_code, effect) VALUES(?,?,'deny')", (gid, code)
                )
        db.audit(self.conn, self.user, self.client_ip(), "perm.group", str(gid), json.dumps(body, ensure_ascii=False))
        self.json_out({"ok": True})

    def api_permission_user(self, match, _query):
        self.require("action.users.manage")
        uid = int(match.group(1))
        body = self.read_json()
        self.conn.execute("DELETE FROM user_permissions WHERE user_id=?", (uid,))
        for code in body.get("allow") or []:
            if code in perms.PERM_CODES:
                self.conn.execute(
                    "INSERT INTO user_permissions(user_id, perm_code, effect) VALUES(?,?,'allow')", (uid, code)
                )
        for code in body.get("deny") or []:
            if code in perms.PERM_CODES:
                self.conn.execute(
                    "INSERT INTO user_permissions(user_id, perm_code, effect) VALUES(?,?,'deny')", (uid, code)
                )
        db.audit(self.conn, self.user, self.client_ip(), "perm.user", str(uid), json.dumps(body, ensure_ascii=False))
        self.json_out({"ok": True})

    def api_scope_save(self, match, _query):
        self.require("action.users.manage")
        owner_type = match.group(1)
        owner_id = int(match.group(2))
        body = self.read_json()
        scopes = body.get("scopes") or {}
        self.conn.execute(
            "DELETE FROM data_scopes WHERE owner_type=? AND owner_id=?", (owner_type, owner_id)
        )
        for dim, values in scopes.items():
            if dim not in perms.SCOPE_DIMS:
                continue
            values = [str(v) for v in (values or []) if str(v).strip()]
            if not values:
                continue
            self.conn.execute(
                "INSERT INTO data_scopes(owner_type, owner_id, dim, values_json) VALUES(?,?,?,?)",
                (owner_type, owner_id, dim, json.dumps(values, ensure_ascii=False)),
            )
        db.audit(self.conn, self.user, self.client_ip(), "scope.save", "%s:%s" % (owner_type, owner_id),
                 json.dumps(scopes, ensure_ascii=False))
        self.json_out({"ok": True})

    def api_audit(self, _match, query):
        self.require("action.audit.view")
        page = max(1, int((query.get("page") or ["1"])[0] or 1))
        size = 50
        total = self.conn.execute("SELECT COUNT(*) AS c FROM audit_log").fetchone()["c"]
        rows = self.conn.execute(
            "SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?", (size, (page - 1) * size)
        ).fetchall()
        self.json_out(
            {
                "total": total,
                "page": page,
                "size": size,
                "rows": [
                    {
                        "id": r["id"],
                        "ts": r["ts"],
                        "username": r["username"],
                        "ip": r["ip"],
                        "action": r["action"],
                        "target": r["target"],
                        "detail": r["detail"],
                    }
                    for r in rows
                ],
            }
        )

    def _groups_payload(self):
        result = []
        for g in self.conn.execute("SELECT * FROM groups ORDER BY id"):
            members = [
                r["user_id"]
                for r in self.conn.execute("SELECT user_id FROM group_members WHERE group_id=?", (g["id"],))
            ]
            allow = [
                r["perm_code"]
                for r in self.conn.execute(
                    "SELECT perm_code FROM group_permissions WHERE group_id=? AND effect='allow'", (g["id"],)
                )
            ]
            deny = [
                r["perm_code"]
                for r in self.conn.execute(
                    "SELECT perm_code FROM group_permissions WHERE group_id=? AND effect='deny'", (g["id"],)
                )
            ]
            scopes = {}
            for r in self.conn.execute(
                "SELECT dim, values_json FROM data_scopes WHERE owner_type='group' AND owner_id=?",
                (g["id"],),
            ):
                try:
                    scopes[r["dim"]] = json.loads(r["values_json"])
                except Exception:
                    pass
            result.append(
                {
                    "id": g["id"],
                    "name": g["name"],
                    "description": g["description"],
                    "members": members,
                    "allow": allow,
                    "deny": deny,
                    "scopes": scopes,
                }
            )
        return result
