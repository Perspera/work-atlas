# -*- coding: utf-8 -*-
"""登录、密码、会话与权限判定。"""
import hashlib
import hmac
import os
import re
import secrets
from datetime import datetime, timedelta

from backend.core import db
from backend.core import perms

PBKDF2_ROUNDS = 200_000
LOCK_WINDOW_SEC = 300
LOCK_MAX_FAILS = 5
LOCK_SECONDS = 60


# ---------------------------------------------------------------- 密码
def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS)
    return digest.hex(), salt.hex()


def verify_password(password, pwd_hash, salt_hex):
    try:
        salt = bytes.fromhex(salt_hex)
    except Exception:
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS)
    return hmac.compare_digest(digest.hex(), pwd_hash or "")


def password_problem(password):
    """返回中文错误信息；合格返回 None。"""
    if not password or len(password) < 8:
        return "密码至少 8 位"
    if not re.search(r"[A-Za-z]", password):
        return "密码需包含字母"
    if not re.search(r"\d", password):
        return "密码需包含数字"
    return None


# ---------------------------------------------------------------- 用户
def has_users(conn):
    row = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()
    return (row["c"] or 0) > 0


def get_user_by_username(conn, username):
    return conn.execute(
        "SELECT * FROM users WHERE username=?", (username or "",)
    ).fetchone()


def get_user(conn, user_id):
    return conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()


def create_user(conn, username, display_name, password, role="viewer", must_change=1):
    pwd_hash, salt = hash_password(password)
    cur = conn.execute(
        "INSERT INTO users(username, display_name, pwd_hash, salt, status, must_change_pwd, created_at) "
        "VALUES(?,?,?,?, 'active', ?, ?)",
        (
            username,
            display_name or username,
            pwd_hash,
            salt,
            1 if must_change else 0,
            db.now_str(),
        ),
    )
    uid = cur.lastrowid
    for code in perms.preset_codes(role):
        conn.execute(
            "INSERT OR REPLACE INTO user_permissions(user_id, perm_code, effect) VALUES(?,?,'allow')",
            (uid, code),
        )
    return uid


def set_password(conn, user_id, password, must_change=0, is_default=0):
    pwd_hash, salt = hash_password(password)
    conn.execute(
        "UPDATE users SET pwd_hash=?, salt=?, must_change_pwd=?, pwd_is_default=? WHERE id=?",
        (pwd_hash, salt, 1 if must_change else 0, 1 if is_default else 0, user_id),
    )


# ---------------------------------------------------------------- 登录限流
def _fail_count(conn, username, ip):
    since = datetime.now().timestamp() - LOCK_WINDOW_SEC
    row = conn.execute(
        "SELECT COUNT(*) AS c, MAX(ts) AS last FROM login_attempts "
        "WHERE username=? AND ip=? AND ok=0 AND ts>?",
        (username or "", ip or "", since),
    ).fetchone()
    return (row["c"] or 0), (row["last"] or 0)


def check_locked(conn, username, ip):
    count, last = _fail_count(conn, username, ip)
    if count >= LOCK_MAX_FAILS:
        remain = int(last + LOCK_SECONDS - datetime.now().timestamp())
        if remain > 0:
            return remain
    return 0


def record_attempt(conn, username, ip, ok):
    conn.execute(
        "INSERT INTO login_attempts(username, ip, ts, ok) VALUES(?,?,?,?)",
        (username or "", ip or "", datetime.now().timestamp(), 1 if ok else 0),
    )


def authenticate(conn, username, password, ip):
    """返回 (user_row, error_message)。"""
    remain = check_locked(conn, username, ip)
    if remain > 0:
        return None, "登录失败次数过多，请 %d 秒后再试" % remain
    row = get_user_by_username(conn, username)
    if not row or row["status"] != "active":
        record_attempt(conn, username, ip, False)
        return None, "用户名或密码错误"
    if not verify_password(password, row["pwd_hash"], row["salt"]):
        record_attempt(conn, username, ip, False)
        return None, "用户名或密码错误"
    record_attempt(conn, username, ip, True)
    conn.execute(
        "UPDATE users SET last_login_at=? WHERE id=?", (db.now_str(), row["id"])
    )
    return row, None


# ---------------------------------------------------------------- 会话
def create_session(conn, user_id, ip, ua, hours=12):
    token = secrets.token_urlsafe(32)
    now = datetime.now()
    conn.execute(
        "INSERT INTO sessions(token, user_id, created_at, expires_at, ip, ua) VALUES(?,?,?,?,?,?)",
        (
            token,
            user_id,
            now.strftime("%Y-%m-%d %H:%M:%S"),
            (now + timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S"),
            ip or "",
            (ua or "")[:300],
        ),
    )
    return token


def session_user(conn, token, touch_hours=12):
    if not token:
        return None
    row = conn.execute("SELECT * FROM sessions WHERE token=?", (token,)).fetchone()
    if not row:
        return None
    if row["expires_at"] < db.now_str():
        conn.execute("DELETE FROM sessions WHERE token=?", (token,))
        return None
    # 滑动续期
    conn.execute(
        "UPDATE sessions SET expires_at=? WHERE token=?",
        (
            (datetime.now() + timedelta(hours=touch_hours)).strftime("%Y-%m-%d %H:%M:%S"),
            token,
        ),
    )
    user = get_user(conn, row["user_id"])
    if not user or user["status"] != "active":
        return None
    return user


def destroy_session(conn, token):
    if token:
        conn.execute("DELETE FROM sessions WHERE token=?", (token,))


def cleanup_sessions(conn):
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", (db.now_str(),))
    conn.execute("DELETE FROM login_attempts WHERE ts < ?", (datetime.now().timestamp() - 86400,))


# ---------------------------------------------------------------- 权限
def effective_permissions(conn, user_id):
    """组权限并集 + 用户追加 - 用户拒绝（拒绝优先）。"""
    allow = set()
    deny = set()
    for row in conn.execute(
        "SELECT gp.perm_code, gp.effect FROM group_permissions gp "
        "JOIN group_members gm ON gm.group_id = gp.group_id WHERE gm.user_id=?",
        (user_id,),
    ):
        (deny if row["effect"] == "deny" else allow).add(row["perm_code"])
    for row in conn.execute(
        "SELECT perm_code, effect FROM user_permissions WHERE user_id=?", (user_id,)
    ):
        (deny if row["effect"] == "deny" else allow).add(row["perm_code"])
    return allow - deny


def has(user_perms, code):
    if not code:
        return True
    if "*" in user_perms:
        return True
    return code in user_perms


def ensure_presets(conn):
    """把"新增的权限点"补发给已存在用户。

    权限是在建用户时按角色预设物化的；后续版本新增权限点（如 page.orders）时，
    老用户不会被自动带上。这里按用户现有的权限画像推断角色，把预设里缺的
    allow 行补上：显式 deny 仍优先（同主键存在 deny 行时 INSERT OR IGNORE 不生效）。
    """
    for row in conn.execute("SELECT id FROM users").fetchall():
        uid = row["id"]
        current = effective_permissions(conn, uid)
        if not current:
            continue
        if "action.users.manage" in current:
            role = "admin"
        elif "action.waves.create" in current:
            role = "editor"
        else:
            role = "viewer"
        for code in perms.PRESETS.get(role, set()):
            conn.execute(
                "INSERT OR IGNORE INTO user_permissions(user_id, perm_code, effect) VALUES(?,?,'allow')",
                (uid, code),
            )


def require(user_perms, *codes):
    """任一权限满足即可。"""
    if not codes:
        return True
    return any(has(user_perms, c) for c in codes)


# ---------------------------------------------------------------- 数据范围
def scope_rows(conn, user_id):
    """返回该用户（自身+所属组）的数据范围行。空列表=不限。"""
    rows = []
    for row in conn.execute(
        "SELECT ds.dim, ds.values_json FROM data_scopes ds "
        "JOIN group_members gm ON gm.group_id = ds.owner_id "
        "WHERE ds.owner_type='group' AND gm.user_id=?",
        (user_id,),
    ):
        rows.append((row["dim"], row["values_json"]))
    for row in conn.execute(
        "SELECT dim, values_json FROM data_scopes WHERE owner_type='user' AND owner_id=?",
        (user_id,),
    ):
        rows.append((row["dim"], row["values_json"]))
    return rows


def scope_summary(conn, user_id):
    """给前端展示用的数据范围描述。"""
    result = {}
    for dim, values_json in scope_rows(conn, user_id):
        try:
            import json

            values = json.loads(values_json)
        except Exception:
            values = []
        if not values:
            continue
        result.setdefault(dim, [])
        for v in values:
            if v not in result[dim]:
                result[dim].append(v)
    return result


def is_admin(conn, user_id):
    return "action.users.manage" in effective_permissions(conn, user_id)


# ---------------------------------------------------------------- 初始化
def ensure_initial_admin(conn, username, password, display_name="管理员"):
    """首次启动创建管理员（仅当用户表为空）。"""
    if has_users(conn):
        return False
    uid = create_user(conn, username, display_name, password, role="admin", must_change=0)
    # 首次初始化用的口令视为默认口令：必须先改密才能使用系统
    conn.execute("UPDATE users SET pwd_is_default=1 WHERE id=?", (uid,))
    conn.execute("INSERT OR IGNORE INTO groups(name, description) VALUES('管理员组','拥有全部权限')")
    gid = conn.execute("SELECT id FROM groups WHERE name='管理员组'").fetchone()["id"]
    conn.execute("INSERT OR IGNORE INTO group_members(group_id, user_id) VALUES(?,?)", (gid, uid))
    return True
