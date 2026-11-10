# -*- coding: utf-8 -*-
"""线路超时预警：设置、判定、站内通知。

判定口径（已与用户确认）：
  - 完成 = 该线路当天已登记订单组的**复核完成率 100%**（按行数，check_time 非空）
  - 提前提醒：now >= 截止时间 - lead_minutes（默认 30），每个「天+线路+级别」只发一次
  - 超时告警：now >= 截止时间，按 15 分钟桶去重重复发送，直到完成或跨天
  - 接收人：线路负责人（route_owners）；没配负责人时兜底发管理员
"""
from datetime import datetime, timedelta

import db
import rules

DEFAULT_DEADLINE_AM = "12:00"
DEFAULT_DEADLINE_PM = "17:00"
DEFAULT_DEADLINE_OTHER = "16:00"


def default_deadline(route):
    name = route or ""
    if name.startswith("上午"):
        return DEFAULT_DEADLINE_AM
    if name.startswith("下午"):
        return DEFAULT_DEADLINE_PM
    return DEFAULT_DEADLINE_OTHER


def ensure_settings(conn, routes):
    """给新出现的线路补一条默认设置（已存在的不动）。"""
    now = db.now_str()
    changed = False
    for route in routes:
        row = conn.execute("SELECT route FROM route_settings WHERE route=?", (route,)).fetchone()
        if row:
            continue
        conn.execute(
            "INSERT INTO route_settings(route, deadline, enabled, updated_at) VALUES(?,?,1,?)",
            (route, default_deadline(route), now),
        )
        changed = True
    return changed


def settings(conn):
    rows = conn.execute(
        "SELECT r.route, r.deadline, r.enabled FROM route_settings r ORDER BY r.route"
    ).fetchall()
    owners = {}
    for row in conn.execute(
        "SELECT ro.route, ro.user_id, u.username, u.display_name FROM route_owners ro "
        "LEFT JOIN users u ON u.id = ro.user_id ORDER BY ro.user_id"
    ):
        owners.setdefault(row["route"], []).append(
            {"id": row["user_id"], "username": row["username"], "display_name": row["display_name"]}
        )
    return [
        {
            "route": r["route"],
            "deadline": r["deadline"],
            "enabled": bool(r["enabled"]),
            "owners": owners.get(r["route"], []),
        }
        for r in rows
    ]


def _minutes_since_midnight(text):
    try:
        hour, minute = str(text).split(":")[:2]
        return int(hour) * 60 + int(minute)
    except (ValueError, AttributeError):
        return None


def status_now(conn, biz_date, now=None):
    """返回每条线路的当前状态（含完成率、截止时间、是否超时）。"""
    now = now or datetime.now()
    today = db.today_str()
    rows = rules.route_completion(conn, biz_date)
    conf = {item["route"]: item for item in settings(conn)}
    ensure_settings(conn, [r["route"] for r in rows])
    conf = {item["route"]: item for item in settings(conn)}

    result = []
    for item in rows:
        setting = conf.get(item["route"]) or {}
        deadline = setting.get("deadline") or default_deadline(item["route"])
        enabled = setting.get("enabled", True)
        deadline_min = _minutes_since_midnight(deadline)
        now_min = now.hour * 60 + now.minute
        remaining_min = None if deadline_min is None else deadline_min - now_min
        state = "done" if item["done"] else "running"
        if item["done"]:
            state = "done"
        elif not enabled:
            state = "disabled"
        elif biz_date != today:
            state = "closed"
        elif remaining_min is not None and remaining_min <= 0:
            state = "overdue"
        elif remaining_min is not None and remaining_min <= 30:
            state = "due_soon"
        result.append(
            dict(
                item,
                deadline=deadline,
                enabled=enabled,
                owners=setting.get("owners", []),
                remaining_minutes=remaining_min,
                state=state,
            )
        )
    result.sort(key=lambda x: (x["state"] != "overdue", x["state"] != "due_soon",
                                -(x.get("remaining") or 0)))
    return result


def _owners_for(conn, route):
    ids = [
        r["user_id"]
        for r in conn.execute("SELECT user_id FROM route_owners WHERE route=?", (route,))
    ]
    if ids:
        return ids
    # 兜底：管理员
    return [
        r["id"]
        for r in conn.execute(
            "SELECT u.id FROM users u JOIN user_permissions p ON p.user_id=u.id "
            "WHERE p.perm_code='action.users.manage' AND p.effect='allow' AND u.status='active'"
        )
    ]


def generate(conn, biz_date=None, now=None, lead_minutes=None):
    """扫描并生成未读通知（幂等）。返回新建条数。"""
    now = now or datetime.now()
    biz_date = biz_date or db.today_str()
    lead = int((db.get_meta(conn, "alert_lead_minutes") or 30)) if lead_minutes is None else lead_minutes
    interval = int(db.get_meta(conn, "alert_repeat_minutes") or 15)

    created = 0
    for item in status_now(conn, biz_date, now):
        state = item["state"]
        if state not in ("due_soon", "overdue"):
            continue
        deadline_min = _minutes_since_midnight(item["deadline"])
        if deadline_min is None:
            continue
        now_min = now.hour * 60 + now.minute
        if state == "overdue":
            bucket = int((now_min - deadline_min) // max(1, interval))
            level, kind = "danger", "route_overdue"
            title = "线路超时未完成：%s" % item["route"]
        else:
            bucket = 0
            level, kind = "warn", "route_due_soon"
            title = "线路即将到截止时间：%s" % item["route"]
        dedupe = "%s|%s|%s|%d" % (biz_date, item["route"], level, bucket)
        exists = conn.execute(
            "SELECT 1 FROM notifications WHERE dedupe_key=?", (dedupe,)
        ).fetchone()
        if exists:
            continue
        rate_text = "%.1f%%" % (item["rate"] * 100)
        body = (
            "截止 %s，当前复核完成率 %s，剩余 %d 行未复核（共 %d 行）。"
            % (item["deadline"], rate_text, item["remaining"], item["lines"])
        )
        for user_id in _owners_for(conn, item["route"]):
            conn.execute(
                "INSERT OR IGNORE INTO notifications(user_id, kind, level, biz_date, route, "
                "title, body, created_at, dedupe_key) VALUES(?,?,?,?,?,?,?,?,?)",
                (user_id, kind, level, biz_date, item["route"], title, body, db.now_str(),
                 "%s|u%d" % (dedupe, user_id)),
            )
            created += 1
    if created:
        db.bump_version(conn)
    return created


def unread_count(conn, user_id):
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM notifications WHERE user_id=? AND read_at IS NULL",
        (user_id,),
    ).fetchone()
    return row["c"] or 0


def list_notifications(conn, user_id=None, unread_only=False, limit=100, all_users=False):
    where = []
    params = []
    if not all_users:
        where.append("user_id = ?")
        params.append(user_id)
    if unread_only:
        where.append("read_at IS NULL")
    sql = "SELECT * FROM notifications"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in conn.execute(sql, params)]


def mark_read(conn, user_id, ids=None, all_users=False):
    if all_users:
        count = conn.execute(
            "UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL",
            (db.now_str(), user_id),
        ).rowcount
    else:
        marks = ",".join("?" * len(ids or []))
        count = 0
        if ids:
            count = conn.execute(
                "UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL "
                "AND id IN (%s)" % marks,
                [db.now_str(), user_id] + list(ids),
            ).rowcount
    return count


def screen_state(conn, biz_date=None):
    """大屏红条：当前所有超时线路。"""
    biz_date = biz_date or db.today_str()
    items = [i for i in status_now(conn, biz_date) if i["state"] in ("overdue", "due_soon")]
    return {
        "biz_date": biz_date,
        "overdue": [i for i in items if i["state"] == "overdue"],
        "due_soon": [i for i in items if i["state"] == "due_soon"],
    }
