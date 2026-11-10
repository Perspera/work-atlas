# -*- coding: utf-8 -*-
"""看板总台、页面布局、组件取数、大屏"""

import alerts
import auth
import db
import json
import re
import rules
import templates
import widgets

from api.boards_init import (
    PAGE_TEMPLATES,
    ensure_default_dashboards,
    ensure_page_dashboards,
    ensure_user_dashboards,
)
from api.runtime import CONFIG, HUB, ApiError


class DashboardMixin:

    def api_dashboards(self, _match, _query):
        self.require("page.dashboard")
        ensure_default_dashboards(self.conn)
        ensure_user_dashboards(self.conn, self.user["id"])
        rows = self.conn.execute(
            "SELECT * FROM dashboards WHERE page_key IS NULL AND (owner_user_id IS NULL OR owner_user_id=?) "
            "ORDER BY (owner_user_id IS NULL) ASC, id",
            (self.user["id"],),
        ).fetchall()
        self.json_out(
            {
                "rows": [
                    {
                        "id": r["id"],
                        "name": r["name"],
                        "owner_user_id": r["owner_user_id"],
                        "visibility": r["visibility"],
                        "is_default": r["is_default"],
                        "version": r["version"],
                        "updated_at": r["updated_at"],
                        "layout": json.loads(r["layout_json"] or '{"widgets":[]}'),
                        "editable": r["owner_user_id"] == self.user["id"],
                    }
                    for r in rows
                ]
            }
        )

    def api_dashboard_create(self, _match, _query):
        self.require("action.dashboard.edit")
        body = self.read_json()
        name = (body.get("name") or "我的看板").strip()[:40]
        layout = body.get("layout") or {"widgets": []}
        cur = self.conn.execute(
            "INSERT INTO dashboards(name, owner_user_id, visibility, is_default, layout_json, version, updated_at) "
            "VALUES(?,?,'private',0,?,1,?)",
            (name, self.user["id"], json.dumps(layout, ensure_ascii=False), db.now_str()),
        )
        db.audit(self.conn, self.user, self.client_ip(), "dashboard.create", name, "")
        self.json_out({"ok": True, "id": cur.lastrowid})

    def api_dashboard_update(self, match, _query):
        self.require("action.dashboard.edit")
        did = int(match.group(1))
        row = self.conn.execute("SELECT * FROM dashboards WHERE id=?", (did,)).fetchone()
        if not row:
            raise ApiError(404, "看板不存在")
        if row["owner_user_id"] != self.user["id"]:
            raise ApiError(403, "只能修改自己的看板")
        body = self.read_json()
        layout = body.get("layout")
        if layout is not None:
            if not isinstance(layout, dict) or not isinstance(layout.get("widgets"), list):
                raise ApiError(400, "布局格式不正确")
            if len(layout["widgets"]) > 60:
                raise ApiError(400, "组件数量超过上限")
            for widget in layout["widgets"]:
                if widget.get("type") not in (
                    "kpi", "bar", "line", "pie", "funnel", "table", "detail", "alert", "progress", "text"
                ):
                    raise ApiError(400, "未知组件类型")
            layout_json = json.dumps(layout, ensure_ascii=False)
            self.conn.execute(
                "UPDATE dashboards SET layout_json=?, version=version+1, name=?, updated_at=? WHERE id=?",
                (layout_json, (body.get("name") or row["name"])[:40], db.now_str(), did),
            )
        elif body.get("name"):
            self.conn.execute(
                "UPDATE dashboards SET name=?, version=version+1, updated_at=? WHERE id=?",
                (body["name"][:40], db.now_str(), did),
            )
        db.audit(self.conn, self.user, self.client_ip(), "dashboard.update", row["name"], "")
        self.json_out({"ok": True})

    def api_dashboard_publish(self, match, _query):
        self.require("action.dashboard.publish")
        did = int(match.group(1))
        row = self.conn.execute("SELECT * FROM dashboards WHERE id=?", (did,)).fetchone()
        if not row:
            raise ApiError(404, "看板不存在")
        if row["owner_user_id"] != self.user["id"] and not auth.is_admin(self.conn, self.user["id"]):
            raise ApiError(403, "只能发布自己的看板")
        exists = self.conn.execute(
            "SELECT id FROM dashboards WHERE owner_user_id IS NULL AND name=?", (row["name"],)
        ).fetchone()
        if exists:
            self.conn.execute(
                "UPDATE dashboards SET layout_json=?, version=version+1, updated_at=? WHERE id=?",
                (row["layout_json"], db.now_str(), exists["id"]),
            )
            target = exists["id"]
        else:
            cur = self.conn.execute(
                "INSERT INTO dashboards(name, owner_user_id, visibility, is_default, layout_json, version, updated_at) "
                "VALUES(?,NULL,'shared',0,?,1,?)",
                (row["name"] + "（公共）", row["layout_json"], db.now_str()),
            )
            target = cur.lastrowid
        db.audit(self.conn, self.user, self.client_ip(), "dashboard.publish", row["name"], "->%s" % target)
        self.json_out({"ok": True, "id": target})

    def api_dashboard_delete(self, match, _query):
        self.require("action.dashboard.edit")
        did = int(match.group(1))
        row = self.conn.execute("SELECT * FROM dashboards WHERE id=?", (did,)).fetchone()
        if not row:
            raise ApiError(404, "看板不存在")
        if row["owner_user_id"] != self.user["id"]:
            raise ApiError(403, "只能删除自己的看板")
        count = self.conn.execute(
            "SELECT COUNT(*) AS c FROM dashboards WHERE owner_user_id=? AND page_key IS NULL",
            (self.user["id"],),
        ).fetchone()["c"]
        if (count or 0) <= 1:
            raise ApiError(400, "至少保留一个看板")
        self.conn.execute("DELETE FROM dashboards WHERE id=?", (did,))
        db.audit(self.conn, self.user, self.client_ip(), "dashboard.delete", row["name"], "")
        self.json_out({"ok": True})

    def api_dashboard_get(self, match, _query):
        self.require("page.dashboard")
        did = int(match.group(1))
        row = self.conn.execute("SELECT * FROM dashboards WHERE id=?", (did,)).fetchone()
        if not row:
            raise ApiError(404, "看板不存在")
        if row["owner_user_id"] not in (None, self.user["id"]):
            raise ApiError(403, "无权查看该看板")
        self.json_out(
            {
                "id": row["id"],
                "name": row["name"],
                "owner_user_id": row["owner_user_id"],
                "visibility": row["visibility"],
                "version": row["version"],
                "updated_at": row["updated_at"],
                "layout": self._layout_of(row),
                "editable": row["owner_user_id"] == self.user["id"],
                "can_publish": "action.dashboard.publish" in self.perms,
            }
        )

    def api_pages(self, _match, _query):
        self.require(
            "page.overview", "page.progress", "page.volume", "page.labor", "page.trend"
        )
        ensure_page_dashboards(self.conn)
        rows = []
        for item in templates.PAGE_TEMPLATES:
            public = self._page_row(item["key"])
            personal = self._page_row(item["key"], self.user["id"])
            rows.append(
                {
                    "key": item["key"],
                    "name": item["name"],
                    "public_version": public["version"] if public else 0,
                    "public_updated_at": public["updated_at"] if public else None,
                    "personal_version": personal["version"] if personal else 0,
                    "personal_updated_at": personal["updated_at"] if personal else None,
                    "source": "personal" if personal else "public",
                }
            )
        self.json_out({"rows": rows})

    def api_page_get(self, match, _query):
        key = match.group(1)
        if key not in PAGE_TEMPLATES:
            raise ApiError(404, "页面不存在")
        self.require("page." + key)
        ensure_page_dashboards(self.conn)
        public = self._page_row(key)
        personal = self._page_row(key, self.user["id"])
        source = personal or public
        if not source:
            raise ApiError(404, "该页面还没有默认看板")
        try:
            layout = json.loads(source["layout_json"] or '{"widgets":[]}')
        except ValueError:
            layout = {"widgets": []}
        self.json_out(
            {
                "key": key,
                "name": source["name"],
                "layout": layout,
                "source": "personal" if personal else "public",
                "public_version": public["version"] if public else 0,
                "public_updated_at": public["updated_at"] if public else None,
                "public_name": public["name"] if public else None,
                "personal_version": personal["version"] if personal else 0,
                "personal_updated_at": personal["updated_at"] if personal else None,
                "can_edit": "action.dashboard.edit" in self.perms,
                "can_publish": "action.dashboard.publish" in self.perms,
            }
        )

    def api_page_save(self, match, _query):
        key = match.group(1)
        if key not in PAGE_TEMPLATES:
            raise ApiError(404, "页面不存在")
        self.require("action.dashboard.edit")
        body = self.read_json()
        target = (body.get("target") or "personal").lower()
        layout = self._validate_layout(body.get("layout") or {})
        layout_json = json.dumps(layout, ensure_ascii=False)
        if target == "public":
            if "action.dashboard.publish" not in self.perms:
                raise ApiError(403, "没有发布公共默认的权限")
            row = self._page_row(key)
            if not row:
                raise ApiError(404, "公共默认不存在")
            self.conn.execute(
                "UPDATE dashboards SET layout_json=?, version=version+1, name=?, updated_at=? WHERE id=?",
                (layout_json, (body.get("name") or row["name"])[:40], db.now_str(), row["id"]),
            )
            db.audit(self.conn, self.user, self.client_ip(), "page.publish", key, "v%d" % (row["version"] + 1))
        else:
            personal = self._page_row(key, self.user["id"])
            if personal:
                self.conn.execute(
                    "UPDATE dashboards SET layout_json=?, version=version+1, updated_at=? WHERE id=?",
                    (layout_json, db.now_str(), personal["id"]),
                )
            else:
                public = self._page_row(key)
                self.conn.execute(
                    "INSERT INTO dashboards(name, owner_user_id, visibility, is_default, layout_json, "
                    "version, updated_at, page_key) VALUES(?,?,'private',0,?,1,?,?)",
                    ((public["name"] if public else key), self.user["id"], layout_json, db.now_str(), key),
                )
            db.audit(self.conn, self.user, self.client_ip(), "page.save", key, "")
        db.bump_version(self.conn)
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True, "target": target})

    def api_page_reset(self, match, _query):
        key = match.group(1)
        if key not in PAGE_TEMPLATES:
            raise ApiError(404, "页面不存在")
        self.require("action.dashboard.edit")
        self.conn.execute(
            "DELETE FROM dashboards WHERE page_key=? AND owner_user_id=?", (key, self.user["id"])
        )
        db.audit(self.conn, self.user, self.client_ip(), "page.reset", key, "")
        db.bump_version(self.conn)
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True})

    def api_boards(self, _match, _query):
        self.require("page.dashboard")
        ensure_page_dashboards(self.conn)
        pages = []
        for item in templates.PAGE_TEMPLATES:
            if "page." + item["key"] not in self.perms:
                continue
            public = self._page_row(item["key"])
            personal = self._page_row(item["key"], self.user["id"])
            effective = personal or public
            layout = self._layout_of(effective) if effective else {"widgets": []}
            pages.append(
                {
                    "kind": "page",
                    "key": item["key"],
                    "name": item["name"],
                    "source": "personal" if personal else "public",
                    "public_version": public["version"] if public else 0,
                    "public_updated_at": public["updated_at"] if public else None,
                    "personal_version": personal["version"] if personal else 0,
                    "personal_updated_at": personal["updated_at"] if personal else None,
                    "widgets": len(layout.get("widgets") or []),
                    "layout": layout,
                    "can_edit": "action.dashboard.edit" in self.perms,
                    "can_publish": "action.dashboard.publish" in self.perms,
                }
            )

        dash_rows = self.conn.execute(
            "SELECT d.*, u.username AS owner_name FROM dashboards d "
            "LEFT JOIN users u ON u.id = d.owner_user_id "
            "WHERE d.page_key IS NULL AND (d.owner_user_id IS NULL OR d.owner_user_id=?) "
            "ORDER BY (d.owner_user_id IS NULL) ASC, d.id",
            (self.user["id"],),
        ).fetchall()
        dashboards = []
        for row in dash_rows:
            layout = self._layout_of(row)
            dashboards.append(
                {
                    "kind": "dashboard",
                    "id": row["id"],
                    "name": row["name"],
                    "owner_user_id": row["owner_user_id"],
                    "owner_name": row["owner_name"],
                    "visibility": row["visibility"],
                    "version": row["version"],
                    "updated_at": row["updated_at"],
                    "widgets": len(layout.get("widgets") or []),
                    "layout": layout,
                    "editable": row["owner_user_id"] == self.user["id"],
                    "is_public": row["owner_user_id"] is None,
                }
            )

        orphans = []
        if "action.users.manage" in self.perms:
            orphans = [
                dict(r)
                for r in self.conn.execute(
                    "SELECT d.id, d.name, d.owner_user_id, d.updated_at FROM dashboards d "
                    "WHERE d.owner_user_id IS NOT NULL AND NOT EXISTS "
                    "(SELECT 1 FROM users u WHERE u.id = d.owner_user_id) ORDER BY d.id"
                )
            ]

        self.json_out(
            {
                "pages": pages,
                "dashboards": dashboards,
                "orphans": orphans,
                "screen": self._screen_config(),
                "can_screen": "action.screen.config" in self.perms,
                "can_create": "action.dashboard.edit" in self.perms,
                "can_publish": "action.dashboard.publish" in self.perms,
            }
        )

    def api_boards_from_page(self, _match, _query):
        self.require("action.dashboard.edit")
        body = self.read_json()
        key = (body.get("key") or "").strip()
        if key not in PAGE_TEMPLATES:
            raise ApiError(404, "页面不存在")
        self.require("page." + key)
        public = self._page_row(key)
        personal = self._page_row(key, self.user["id"])
        source = personal or public
        if not source:
            raise ApiError(404, "该页面还没有布局")
        layout = self._layout_of(source)
        name = (body.get("name") or (source["name"] + " 副本")).strip()[:40]
        cur = self.conn.execute(
            "INSERT INTO dashboards(name, owner_user_id, visibility, is_default, layout_json, "
            "version, updated_at) VALUES(?,?,'private',0,?,1,?)",
            (name, self.user["id"], json.dumps(layout, ensure_ascii=False), db.now_str()),
        )
        db.audit(self.conn, self.user, self.client_ip(), "board.copy_from_page", key, name)
        db.bump_version(self.conn)
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True, "id": cur.lastrowid, "name": name})

    def api_boards_cleanup(self, _match, _query):
        self.require("action.users.manage")
        rows = self.conn.execute(
            "SELECT d.id FROM dashboards d WHERE d.owner_user_id IS NOT NULL AND NOT EXISTS "
            "(SELECT 1 FROM users u WHERE u.id = d.owner_user_id)"
        ).fetchall()
        ids = [r["id"] for r in rows]
        if ids:
            self.conn.execute(
                "DELETE FROM dashboards WHERE id IN (%s)" % ",".join("?" * len(ids)), ids
            )
        db.audit(self.conn, self.user, self.client_ip(), "board.cleanup", "孤儿看板", str(len(ids)))
        db.bump_version(self.conn)
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True, "deleted": ids})

    def api_screen(self, _match, _query):
        self.require("page.screen")
        config = self._screen_config()
        available = [
            {"id": item["key"], "title": item["name"]}
            for item in templates.PAGE_TEMPLATES
        ]
        for row in self.conn.execute(
            "SELECT id, name FROM dashboards WHERE owner_user_id IS NULL AND page_key IS NULL ORDER BY id"
        ):
            available.append({"id": "dash:%d" % row["id"], "title": row["name"]})
        self.json_out(
            {
                "config": config,
                "available": available,
                "can_config": "action.screen.config" in self.perms,
                "title": db.get_meta(self.conn, "site_title", "单量与作业进度看板"),
            }
        )

    def api_screen_save(self, _match, _query):
        self.require("action.screen.config")
        body = self.read_json()
        config = self._screen_config()
        if isinstance(body.get("items"), list):
            config["items"] = [str(x) for x in body["items"]][:20]
        if body.get("interval") is not None:
            try:
                config["interval"] = max(5, min(300, int(body["interval"])))
            except (TypeError, ValueError):
                pass
        if "sound" in body:
            config["sound"] = bool(body["sound"])
        db.set_meta(self.conn, "screen_config", json.dumps(config, ensure_ascii=False))
        db.audit(self.conn, self.user, self.client_ip(), "screen.config", "大屏", json.dumps(config["items"]))
        self.json_out({"ok": True, "config": config})

    def api_screen_data(self, _match, query):
        self.require("page.screen")
        date = (query.get("date") or [""])[0].strip()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            today = db.today_str()
            registered_today = self.conn.execute(
                "SELECT 1 FROM wave_registry WHERE biz_date=? AND deleted_at IS NULL LIMIT 1", (today,)
            ).fetchone()
            dates = rules.biz_dates(self.conn)
            date = today if registered_today or not dates else dates[0]["biz_date"]
        config = self._screen_config()
        items = []
        for item_id in config["items"]:
            row = None
            if item_id in PAGE_TEMPLATES:
                row = self.conn.execute(
                    "SELECT * FROM dashboards WHERE page_key=? AND owner_user_id IS NULL", (item_id,)
                ).fetchone()
            elif str(item_id).startswith("dash:"):
                try:
                    did = int(str(item_id).split(":", 1)[1])
                except ValueError:
                    did = 0
                row = self.conn.execute(
                    "SELECT * FROM dashboards WHERE id=? AND owner_user_id IS NULL", (did,)
                ).fetchone()
            if not row:
                continue
            try:
                layout = json.loads(row["layout_json"] or '{"widgets":[]}')
            except ValueError:
                layout = {"widgets": []}
            items.append({"id": item_id, "title": row["name"], "layout": layout})
        self.json_out(
            {
                "items": items,
                "interval": config["interval"],
                "sound": config["sound"],
                "date": date,
                "state": alerts.screen_state(self.conn, date),
                "unread": alerts.unread_count(self.conn, self.user["id"]),
            }
        )

    def api_widget_catalog(self, _match, _query):
        self.require(
            "page.dashboard", "page.overview", "page.progress", "page.volume",
            "page.labor", "page.trend",
        )
        self.json_out(
            {
                "datasets": [
                    {"key": key, "title": value["title"], "dims": value["dims"]}
                    for key, value in widgets.DATASETS.items()
                ],
                "dataset_metrics": {
                    key: list(metrics) for key, metrics in widgets.DATASET_METRICS.items()
                },
                "dim_labels": rules.DIM_LABEL,
                "metric_meta": widgets.METRIC_META,
                "dataset_ui": widgets.DATASET_UI,
                "presets": widgets.PRESETS,
                "filters": list(rules.FILTERABLE),
                "widget_permissions": sorted(p for p in self.perms if p.startswith("widget.")),
                "with_amount": self.with_amount(),
                "cutoff": CONFIG.get("cutoff_time", "16:00"),
            }
        )

    def api_widget(self, _match, _query):
        body = self.read_json()
        widget_type = body.get("widget_type") or "bar"
        if widget_type not in (
            "kpi", "bar", "line", "pie", "funnel", "table", "detail", "alert", "progress", "text"
        ):
            raise ApiError(400, "未知组件类型")
        self.require("widget." + widget_type)
        date = body.get("date") or rules.default_biz_date(self.conn)
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(date)):
            date = rules.default_biz_date(self.conn)
        spec = self.form_amount_guard(body.get("spec") or {})

        if widget_type == "text":
            self.json_out({"kind": "text", "text": body.get("text") or ""})
            return
        archive_mode = (body.get("mode") or "live") == "archive"
        if widget_type in ("kpi", "progress"):
            data = widgets.single_value(
                self.conn, date, self.user["id"], spec, self.with_amount(), archive=archive_mode
            )
            if (body.get("spec") or {}).get("compare"):
                prev_date = rules.previous_biz_date(self.conn, date)
                if prev_date:
                    prev = widgets.single_value(
                        self.conn, prev_date, self.user["id"], spec, self.with_amount()
                    )
                    data["prev_value"] = prev.get("value")
                    data["prev_date"] = prev_date
                    current = data.get("value")
                    before = prev.get("value")
                    if isinstance(current, (int, float)) and isinstance(before, (int, float)) and before:
                        data["delta"] = (current - before) / before
                    else:
                        data["delta"] = None
            self.json_out({"kind": "value", **data, "spec": widgets.normalize_spec(spec)})
            return
        if widget_type in ("funnel",):
            overview = rules.overview(self.conn, date, self.user["id"], self.with_amount())
            self.json_out({"kind": "funnel", "items": overview["funnel"], "biz_date": date})
            return
        data = widgets.run(
            self.conn, date, self.user["id"], spec, self.with_amount(), archive=archive_mode
        )
        data["biz_date"] = date
        self.json_out(data)

    def api_pending_detail(self, _match, query):
        """待组波明细：所选订单日期中波次号为空的行。"""
        self.require("page.overview", "page.dashboard", "page.progress")
        date = (query.get("date") or [""])[0].strip()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            date = rules.default_biz_date(self.conn)
        try:
            page = int((query.get("page") or ["1"])[0])
        except ValueError:
            page = 1
        try:
            page_size = int((query.get("page_size") or ["50"])[0])
        except ValueError:
            page_size = 50
        data = rules.pending_detail(
            self.conn, date, self.user["id"], page=page, page_size=page_size
        )
        if not self.with_amount():
            data["amount"] = None
            for row in data.get("rows") or []:
                row["amount"] = None
        self.json_out(data)

    def _page_row(self, key, user_id=None):
        if user_id is None:
            return self.conn.execute(
                "SELECT * FROM dashboards WHERE page_key=? AND owner_user_id IS NULL", (key,)
            ).fetchone()
        return self.conn.execute(
            "SELECT * FROM dashboards WHERE page_key=? AND owner_user_id=?", (key, user_id)
        ).fetchone()

    def _validate_layout(self, layout):
        if not isinstance(layout, dict) or not isinstance(layout.get("widgets"), list):
            raise ApiError(400, "布局格式不正确")
        if len(layout["widgets"]) > 80:
            raise ApiError(400, "组件数量超过上限")
        allowed = (
            "kpi", "bar", "line", "pie", "funnel", "table", "detail", "alert",
            "progress", "text",
        )
        for widget in layout["widgets"]:
            if widget.get("type") not in allowed:
                raise ApiError(400, "未知组件类型")
        return layout

    @staticmethod
    def _layout_of(row):
        try:
            return json.loads(row["layout_json"] or "{}")
        except (ValueError, TypeError):
            return {"widgets": []}

    def _screen_config(self):
        raw = db.get_meta(self.conn, "screen_config")
        config = {}
        if raw:
            try:
                config = json.loads(raw) or {}
            except ValueError:
                config = {}
        merged = dict(self.SCREEN_DEFAULT)
        merged.update({k: v for k, v in config.items() if k in ("items", "interval", "sound")})
        if not merged.get("items"):
            merged["items"] = list(self.SCREEN_DEFAULT["items"])
        return merged
