# -*- coding: utf-8 -*-
"""人工作业量、工时设置与校正"""

import db
import labor_archive
import re
import rules

from api.runtime import HUB, ApiError


class LaborMixin:

    def api_labor(self, _match, query):
        self.require("page.labor")
        date = (query.get("date") or [""])[0].strip()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            date = rules.default_biz_date(self.conn)
        mode = "archive" if (query.get("mode") or ["live"])[0] == "archive" else "live"
        if mode == "archive":
            data = rules.labor_archive_stats(self.conn, date)
        else:
            data = rules.labor_stats(self.conn, date, self.user["id"])
            data["mode"] = "live"
        adjustments = {
            "%s|%s" % (r["person"], r["role"]): {
                "hours": r["hours"], "note": r["note"], "updated_at": r["updated_at"],
            }
            for r in self.conn.execute(
                "SELECT person, role, hours, note, updated_at FROM labor_adjust WHERE biz_date=?",
                (date,),
            )
        }
        meta = [
            m for m in rules.labor_archive_dates(self.conn) if m["biz_date"] == date
        ]
        self.json_out(
            {
                **data,
                "date": date,
                "adjustments": adjustments,
                "archived": bool(meta),
                "archived_at": meta[0]["archived_at"] if meta else None,
                "archived_rows": meta[0]["rows"] if meta else 0,
                "archive_dates": rules.labor_archive_dates(self.conn),
                "can_adjust": "action.labor.adjust" in self.perms,
                "can_archive": "action.labor.archive" in self.perms,
                "can_settings": "action.labor.settings" in self.perms,
                "gap_minutes": rules.labor_gap_minutes(self.conn),
                "break_count": self.conn.execute(
                    "SELECT COUNT(*) AS c FROM work_breaks WHERE enabled=1"
                ).fetchone()["c"],
            }
        )

    def api_labor_archive(self, _match, _query):
        self.require("action.labor.archive")
        body = self.read_json()
        date = (body.get("date") or db.today_str()).strip()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            raise ApiError(400, "日期格式不正确")
        force = bool(body.get("force"))
        result = labor_archive.snapshot(self.conn, date, self.user, force=force)
        db.audit(self.conn, self.user, self.client_ip(), "labor.archive", date,
                 "force=%s count=%s" % (force, result.get("count")))
        HUB.broadcast(db.get_version(self.conn))
        self.json_out(result)

    def api_labor_archive_dates(self, _match, _query):
        self.require("page.labor")
        self.json_out(
            {
                "rows": rules.labor_archive_dates(self.conn),
                "can_archive": "action.labor.archive" in self.perms,
            }
        )

    def api_labor_settings(self, _match, _query):
        self.require("page.labor")
        data = self._labor_settings_payload()
        data["can_edit"] = "action.labor.settings" in self.perms
        self.json_out(data)

    def api_labor_settings_save(self, _match, _query):
        self.require("action.labor.settings")
        body = self.read_json()
        gap = body.get("gap_minutes")
        if gap is not None:
            try:
                gap = int(gap)
            except (TypeError, ValueError):
                raise ApiError(400, "间隔阈值必须是整数分钟")
            if gap < 1 or gap > 240:
                raise ApiError(400, "间隔阈值应在 1~240 分钟之间")
            db.set_meta(self.conn, "labor_gap_minutes", str(gap))
        breaks = body.get("breaks")
        if isinstance(breaks, list):
            cleaned = []
            for item in breaks[:20]:
                start = str(item.get("start") or "").strip()
                end = str(item.get("end") or "").strip()
                pattern = r"^([01]\d|2[0-3]):[0-5]\d$"
                if not re.match(pattern, start) or not re.match(pattern, end):
                    raise ApiError(400, "休息时段格式应为 HH:MM")
                if end <= start:
                    raise ApiError(400, "休息结束时间必须晚于开始时间")
                cleaned.append(
                    (start, end, 1 if item.get("enabled", True) else 0,
                     (item.get("note") or "")[:60])
                )
            with db.transaction(self.conn):
                self.conn.execute("DELETE FROM work_breaks")
                for row in cleaned:
                    self.conn.execute(
                        "INSERT INTO work_breaks(start_time, end_time, enabled, note, updated_at) "
                        "VALUES(?,?,?,?,?)",
                        (row[0], row[1], row[2], row[3], db.now_str()),
                    )
        db.audit(self.conn, self.user, self.client_ip(), "labor.settings", "", "gap=%s" % gap)
        db.bump_version(self.conn)
        HUB.broadcast(db.get_version(self.conn))
        payload = self._labor_settings_payload()
        payload["ok"] = True
        self.json_out(payload)

    def api_labor_rearchive(self, _match, _query):
        self.require("action.labor.archive")
        dates = [
            r["biz_date"]
            for r in self.conn.execute(
                "SELECT DISTINCT biz_date FROM labor_archive ORDER BY biz_date"
            )
        ]
        done = []
        for biz_date in dates:
            result = labor_archive.snapshot(self.conn, biz_date, self.user, force=True)
            if result.get("ok"):
                done.append(biz_date)
        db.audit(self.conn, self.user, self.client_ip(), "labor.rearchive", "全部", ",".join(done))
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True, "dates": done})

    def api_labor_adjust(self, _match, _query):
        self.require("action.labor.adjust")
        body = self.read_json()
        date = (body.get("date") or db.today_str()).strip()
        person = (body.get("person") or "").strip()
        role = (body.get("role") or "all").strip()
        if role not in ("pick", "check", "all"):
            role = "all"
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date) or not person:
            raise ApiError(400, "参数不完整")
        hours = body.get("hours")
        if hours in (None, ""):
            self.conn.execute(
                "DELETE FROM labor_adjust WHERE biz_date=? AND person=? AND role=?",
                (date, person, role),
            )
            action = "labor.adjust.clear"
        else:
            try:
                hours = float(hours)
            except (TypeError, ValueError):
                raise ApiError(400, "工时必须是数字")
            if hours < 0 or hours > 24:
                raise ApiError(400, "工时应在 0~24 小时之间")
            self.conn.execute(
                "INSERT INTO labor_adjust(biz_date, person, role, hours, note, updated_by, updated_at) "
                "VALUES(?,?,?,?,?,?,?) ON CONFLICT(biz_date, person, role) DO UPDATE SET "
                "hours=excluded.hours, note=excluded.note, updated_by=excluded.updated_by, "
                "updated_at=excluded.updated_at",
                (date, person, role, hours, (body.get("note") or "")[:200],
                 self.user["id"], db.now_str()),
            )
            action = "labor.adjust"
        db.audit(self.conn, self.user, self.client_ip(), action,
                 "%s %s/%s" % (date, person, role), str(hours))
        db.bump_version(self.conn)
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True})

    def _labor_settings_payload(self):
        breaks = [
            {
                "id": r["id"],
                "start": r["start_time"],
                "end": r["end_time"],
                "enabled": bool(r["enabled"]),
                "note": r["note"] or "",
            }
            for r in self.conn.execute(
                "SELECT id, start_time, end_time, enabled, note FROM work_breaks ORDER BY start_time"
            )
        ]
        return {"gap_minutes": rules.labor_gap_minutes(self.conn), "breaks": breaks}
