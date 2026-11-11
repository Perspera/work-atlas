# -*- coding: utf-8 -*-
"""WMS 自动下载管理"""

from backend.core import db
import json
import re
from backend.wms import wms_manage

from api.runtime import ApiError


class WmsMixin:

    def api_wms_download_state(self, _match, query):
        self.require("page.sources")
        try:
            tail = int((query.get("tail") or ["200"])[0])
        except ValueError:
            tail = 200
        try:
            self.json_out(self._wms_state(tail))
        except wms_manage.WmsError as exc:
            self._wms_error(exc)

    def api_wms_download_config(self, _match, _query):
        self.require("action.scan")
        body = self.read_json()
        try:
            config = wms_manage.save_config(body)
            db.audit(self.conn, self.user, self.client_ip(), "wms.config", "WMS自动下载",
                     json.dumps({k: config.get(k) for k in ("url", "dateMode", "deliverDir", "schedule")}, ensure_ascii=False))
            self.json_out(self._wms_state())
        except wms_manage.WmsError as exc:
            self._wms_error(exc)

    def api_wms_download_run(self, _match, _query):
        self.require("action.scan")
        body = self.read_json()
        date = (body.get("date") or "").strip()
        if date and not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            raise ApiError(400, "日期格式应为 YYYY-MM-DD")
        try:
            result = wms_manage.start_run(date or None)
            db.audit(self.conn, self.user, self.client_ip(), "wms.run", "WMS自动下载",
                     "date=%s pid=%s" % (date or "config", result.get("pid")))
            self.json_out({"ok": True, "run": result})
        except wms_manage.WmsError as exc:
            self._wms_error(exc)

    def api_wms_download_run_state(self, _match, _query):
        self.require("page.sources")
        self.json_out({"run": wms_manage.run_status()})

    def api_wms_download_stop(self, _match, _query):
        self.require("action.scan")
        try:
            result = wms_manage.stop_run()
            db.audit(self.conn, self.user, self.client_ip(), "wms.run.stop", "WMS自动下载", "停止当前运行")
            self.json_out({"ok": True, "run": result})
        except wms_manage.WmsError as exc:
            self._wms_error(exc)

    def api_wms_download_schedule(self, _match, _query):
        self.require("action.scan")
        body = self.read_json()
        action = str(body.get("action") or "").strip()
        if action not in ("install", "enable", "disable", "remove"):
            raise ApiError(400, "未知定时任务操作")
        try:
            status = wms_manage.apply_schedule(action)
            db.audit(self.conn, self.user, self.client_ip(), "wms.schedule", "WMS自动下载",
                     json.dumps({"action": action, "status": status}, ensure_ascii=False))
            self.json_out({"ok": True, "task": status, "state": self._wms_state()})
        except wms_manage.WmsError as exc:
            self._wms_error(exc)

    def api_wms_download_log(self, _match, query):
        self.require("page.sources")
        try:
            tail = int((query.get("tail") or ["200"])[0])
        except ValueError:
            tail = 200
        self.json_out(wms_manage.logs(tail))

    def _wms_state(self, tail=200):
        return wms_manage.state(self.conn, tail=tail)

    def _wms_error(self, exc):
        raise ApiError(getattr(exc, "status", 500), str(exc))
