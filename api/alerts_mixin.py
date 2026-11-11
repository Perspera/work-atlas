# -*- coding: utf-8 -*-
"""线路超时预警"""

from backend.domain import alerts
from backend.core import db
import re
from backend.domain import rules

from api.runtime import HUB, ApiError


class AlertsMixin:

    def api_alerts(self, _match, query):
        self.require("page.alerts")
        unread_only = (query.get("unread") or ["0"])[0] == "1"
        all_users = (query.get("all") or ["0"])[0] == "1"
        if all_users and not ("action.alerts.manage" in self.perms or "page.users" in self.perms):
            raise ApiError(403, "没有查看全部预警的权限")
        try:
            limit = int((query.get("limit") or ["100"])[0] or 100)
        except ValueError:
            limit = 100
        rows = alerts.list_notifications(
            self.conn, self.user["id"], unread_only=unread_only,
            limit=min(500, max(1, limit)), all_users=all_users,
        )
        self.json_out({"rows": rows, "unread": alerts.unread_count(self.conn, self.user["id"])})

    def api_alerts_read(self, _match, _query):
        self.require("page.alerts")
        body = self.read_json()
        count = alerts.mark_read(
            self.conn, self.user["id"], ids=body.get("ids") or [], all_users=bool(body.get("all"))
        )
        self.json_out(
            {"ok": True, "count": count, "unread": alerts.unread_count(self.conn, self.user["id"])}
        )

    def api_alert_routes(self, _match, query):
        self.require("page.alerts")
        date = (query.get("date") or [""])[0].strip()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            date = rules.default_biz_date(self.conn)
        state = alerts.status_now(self.conn, date)
        alerts.ensure_settings(self.conn, [i["route"] for i in state])
        conf = alerts.settings(self.conn)
        state_by_route = {i["route"]: i for i in state}
        rows = []
        for item in conf:
            current = state_by_route.get(item["route"]) or {}
            rows.append(
                dict(
                    item,
                    lines=current.get("lines", 0),
                    checked=current.get("checked", 0),
                    remaining=current.get("remaining", 0),
                    rate=current.get("rate", 0.0),
                    done=current.get("done", False),
                    state=current.get("state", "no_data"),
                    remaining_minutes=current.get("remaining_minutes"),
                )
            )
        rows.sort(key=lambda x: (x["state"] not in ("overdue", "due_soon"), -(x.get("remaining") or 0)))
        users = []
        if "action.alerts.manage" in self.perms:
            users = [
                {"id": r["id"], "username": r["username"], "display_name": r["display_name"]}
                for r in self.conn.execute(
                    "SELECT id, username, display_name FROM users WHERE status='active' ORDER BY id"
                )
            ]
        self.json_out(
            {
                "date": date,
                "rows": rows,
                "users": users,
                "can_manage": "action.alerts.manage" in self.perms,
                "lead_minutes": int(db.get_meta(self.conn, "alert_lead_minutes") or 30),
                "repeat_minutes": int(db.get_meta(self.conn, "alert_repeat_minutes") or 15),
                "unread": alerts.unread_count(self.conn, self.user["id"]),
            }
        )

    def api_alert_routes_save(self, _match, _query):
        self.require("action.alerts.manage")
        body = self.read_json()
        route = (body.get("route") or "").strip()
        if not route:
            raise ApiError(400, "缺少线路")
        deadline = (body.get("deadline") or "").strip()
        if deadline and not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", deadline):
            raise ApiError(400, "截止时间格式应为 HH:MM")
        enabled = 1 if body.get("enabled", True) else 0
        self.conn.execute(
            "INSERT INTO route_settings(route, deadline, enabled, updated_at) VALUES(?,?,?,?) "
            "ON CONFLICT(route) DO UPDATE SET deadline=excluded.deadline, enabled=excluded.enabled, "
            "updated_at=excluded.updated_at",
            (route, deadline or alerts.default_deadline(route), enabled, db.now_str()),
        )
        if isinstance(body.get("owners"), list):
            self.conn.execute("DELETE FROM route_owners WHERE route=?", (route,))
            for user_id in body["owners"]:
                try:
                    self.conn.execute(
                        "INSERT OR IGNORE INTO route_owners(route, user_id) VALUES(?,?)",
                        (route, int(user_id)),
                    )
                except (TypeError, ValueError):
                    continue
        db.audit(self.conn, self.user, self.client_ip(), "alerts.route.save", route, deadline)
        db.bump_version(self.conn)
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True})

    def api_alert_state(self, _match, _query):
        self.require("page.alerts", "page.screen")
        self.json_out(alerts.screen_state(self.conn))
