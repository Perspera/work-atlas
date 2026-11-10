# -*- coding: utf-8 -*-
"""订单组/人效归档查询与出库归档"""

import archive
import db
import json
import outbound_archive
import re
import rules

from api.runtime import HUB, ApiError


class ArchiveMixin:

    def api_archive_create(self, _match, _query):
        self.require("action.orders.archive")
        body = self.read_json()
        date = body.get("date") or db.today_str()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(date)):
            raise ApiError(400, "日期格式应为 YYYY-MM-DD")
        result = archive.snapshot(self.conn, date, self.user, force=bool(body.get("force")))
        if not result.get("ok"):
            if result.get("reason") == "exists":
                raise ApiError(409, "该日期已有存档；如需覆盖请使用「重新存档」")
            raise ApiError(400, "该日期没有可存档的订单组")
        db.audit(
            self.conn, self.user, self.client_ip(), "archive.save", date,
            json.dumps(result, ensure_ascii=False),
        )
        HUB.broadcast(db.get_version(self.conn))
        self.json_out(result)

    def api_archive_get(self, _match, query):
        self.require("page.orders")
        date = self.biz_date(query)
        rows = archive.get(self.conn, date)
        meta = rules.archive_meta(self.conn, date)
        self.json_out({"biz_date": date, "rows": rows, **meta})

    def api_archive_dates(self, _match, _query):
        self.require("page.orders")
        self.json_out({"rows": archive.list_dates(self.conn)})

    def api_archive_list(self, _match, _query):
        """数据源页：订单组归档 + 人效归档清单。"""
        self.require("page.sources")
        self.json_out(
            {
                "orders": archive.list_dates(self.conn),
                "labor": rules.labor_archive_dates(self.conn),
                "last_archive_scan": db.get_meta(self.conn, "last_archive_scan"),
                "auto_enabled": True,
            }
        )

    def api_archive_view(self, _match, query):
        """查看某日归档明细（订单组台账 / 人效）。"""
        self.require("page.sources")
        kind = (query.get("type") or ["orders"])[0]
        date = (query.get("date") or [""])[0].strip()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            raise ApiError(400, "日期格式不正确")
        if kind == "labor":
            stats = rules.labor_archive_stats(self.conn, date)
            self.json_out(
                {
                    "type": "labor",
                    "date": date,
                    "rows": stats["rows"],
                    "totals": stats["totals"],
                    "archived_at": stats.get("archived_at"),
                    "raw": rules.labor_archive_get(self.conn, date),
                }
            )
            return
        data = rules.order_groups(
            self.conn, date, self.user["id"], self.with_amount(),
            mode="archive", included="all", page=1, size=1000,
        )
        self.json_out(
            {
                "type": "orders",
                "date": date,
                "rows": data["rows"],
                "total": data.get("total"),
                "summary": data.get("summary"),
                "archived_at": data.get("archived_at"),
            }
        )

    def api_outbound_archive_dates(self, _match, _query):
        self.require("page.sources")
        self.json_out({"rows": outbound_archive.list_dates(self.conn)})

    def api_outbound_archive(self, _match, query):
        """出库流程节点时间跟踪归档元数据。"""
        self.require("page.sources")
        date = (query.get("date") or [""])[0].strip()
        self.json_out({
            "archive": outbound_archive.get_meta(self.conn, date or None),
            "dates": outbound_archive.list_dates(self.conn),
        })

    def api_outbound_archive_query(self, _match, query):
        """按文件表头内容 + 日期区间分页查询归档数据。"""
        self.require("page.sources")
        filters = self._outbound_filters(query)
        try:
            page = int((query.get("page") or ["1"])[0])
        except ValueError:
            page = 1
        try:
            page_size = int((query.get("page_size") or ["50"])[0])
        except ValueError:
            page_size = 50
        data = outbound_archive.query(
            self.conn,
            filters=filters,
            date_col=(query.get("date_col") or [""])[0].strip(),
            date_from=(query.get("from") or [""])[0].strip(),
            date_to=(query.get("to") or [""])[0].strip(),
            page=page,
            page_size=page_size,
            biz_date=(query.get("date") or [""])[0].strip() or None,
        )
        if not data:
            raise ApiError(404, "还没有出库文件归档，请先扫描数据源目录")
        if not self.with_amount():
            headers = data["meta"]["headers"]
            amount_idx = headers.index("金额") if "金额" in headers else -1
            if amount_idx >= 0:
                data["rows"] = [
                    [None if i == amount_idx else v for i, v in enumerate(row)]
                    for row in data["rows"]
                ]
        self.json_out(data)

    def _outbound_filters(self, query):
        cols = query.get("col") or []
        vals = query.get("val") or []
        ops = query.get("op") or []
        filters = []
        for i, col in enumerate(cols):
            if i >= len(vals):
                break
            filters.append({
                "col": col,
                "value": vals[i],
                "op": ops[i] if i < len(ops) else "contains",
            })
        return filters
