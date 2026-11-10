# -*- coding: utf-8 -*-
"""动力电池登记与归档"""

import battery
import battery_archive
import db
import json
import os
import re
import tempfile

from api.runtime import HUB, ApiError


class BatteryMixin:

    def api_battery_rows(self, _match, query):
        self.require("page.battery")
        data = battery.rows(
            self.conn,
            date_from=(query.get("from") or [""])[0].strip(),
            date_to=(query.get("to") or [""])[0].strip(),
            q=(query.get("q") or [""])[0].strip(),
            status=(query.get("status") or [""])[0].strip(),
            page=(query.get("page") or ["1"])[0],
            page_size=(query.get("page_size") or ["50"])[0],
            with_amount=self.with_amount(),
            order_from=(query.get("order_from") or [""])[0].strip(),
            order_to=(query.get("order_to") or [""])[0].strip(),
            reg_from=(query.get("reg_from") or [""])[0].strip(),
            reg_to=(query.get("reg_to") or [""])[0].strip(),
        )
        self.json_out(data)

    def api_battery_confirm(self, _match, _query):
        self.require("action.battery.manage")
        items = self._battery_items(self.read_json())
        if not items:
            raise ApiError(400, "没有要确认的订单组")
        result = battery.confirm(self.conn, items, self.user["id"])
        db.audit(self.conn, self.user, self.client_ip(), "battery.confirm", "",
                 json.dumps(result, ensure_ascii=False))
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True, **result})

    def api_battery_unconfirm(self, _match, _query):
        self.require("action.battery.manage")
        items = self._battery_items(self.read_json())
        result = battery.unconfirm(self.conn, items)
        db.audit(self.conn, self.user, self.client_ip(), "battery.unconfirm", "",
                 json.dumps(result, ensure_ascii=False))
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True, **result})

    def api_battery_parts_import(self, _match, _query):
        self.require("action.battery.manage")
        raw = self.read_body()
        if not raw:
            raise ApiError(400, "没有内容")
        suffix = ".xlsx" if raw[:4] == b"PK\x03\x04" else ".csv"
        tmp = tempfile.NamedTemporaryFile(prefix="battery_parts_", suffix=suffix, delete=False)
        try:
            tmp.write(raw)
            tmp.close()
            count = battery.import_parts(self.conn, tmp.name)
        except Exception as exc:  # noqa: BLE001
            raise ApiError(400, "备件表导入失败：%s" % exc)
        finally:
            try:
                os.remove(tmp.name)
            except OSError:
                pass
        db.audit(self.conn, self.user, self.client_ip(), "battery.parts.import", "", str(count))
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True, "count": count})

    def api_battery_parts(self, _match, _query):
        self.require("page.battery")
        self.json_out(battery.parts_status(self.conn))

    def api_battery_dealers(self, _match, query):
        self.require("page.battery")
        self.json_out({"rows": battery.dealer_lookup(
            self.conn, (query.get("q") or [""])[0].strip(), (query.get("limit") or ["200"])[0]
        )})

    def api_battery_dealer_save(self, _match, _query):
        self.require("action.battery.manage")
        body = self.read_json()
        full = str(body.get("dealer_full") or "").strip()
        if not full:
            raise ApiError(400, "缺少经销商全称")
        try:
            result = battery.save_dealer_map(self.conn, body)
        except ValueError as exc:
            raise ApiError(400, str(exc))
        db.audit(self.conn, self.user, self.client_ip(), "battery.address.save", full,
                 json.dumps(body, ensure_ascii=False))
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True, **result})

    def api_battery_archive_list(self, _match, _query):
        self.require("page.battery")
        self.json_out({"rows": battery_archive.list_dates(self.conn)})

    def api_battery_archive_query(self, _match, query):
        self.require("page.battery")
        data = battery_archive.query(
            self.conn,
            date_from=(query.get("from") or [""])[0].strip(),
            date_to=(query.get("to") or [""])[0].strip(),
            q=(query.get("q") or [""])[0].strip(),
            status=(query.get("status") or [""])[0].strip(),
            page=(query.get("page") or ["1"])[0],
            page_size=(query.get("page_size") or ["50"])[0],
        )
        if not self.with_amount():
            data["summary"]["amount"] = None
            for row in data["rows"]:
                row["amount"] = None
        self.json_out(data)

    def api_battery_archive_save(self, _match, _query):
        self.require("action.battery.manage")
        body = self.read_json()
        date = str(body.get("date") or "").strip()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            raise ApiError(400, "日期格式应为 YYYY-MM-DD")
        result = battery_archive.snapshot(self.conn, date, self.user, force=bool(body.get("force")))
        db.audit(self.conn, self.user, self.client_ip(), "battery.archive", date,
                 json.dumps({"count": result.get("count"), "replaced": result.get("replaced")}, ensure_ascii=False))
        HUB.broadcast(db.get_version(self.conn))
        self.json_out(result)

    def _battery_items(self, body):
        items = body.get("items")
        if not isinstance(items, list):
            items = [body]
        clean = []
        for item in items:
            if not isinstance(item, dict):
                continue
            clean.append({k: str(item.get(k) or "").strip() for k in ("order_date", "group_no", "part_code")})
        return clean
