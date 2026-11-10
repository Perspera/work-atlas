# -*- coding: utf-8 -*-
"""核心看板：元信息、总览、进度、单量、趋势、订单组查询、数据源与扫描"""

import archive
import archive_refresh
import db
import ingest
import json
import os
import re
import rules
import source_archive
import traceback

from api.runtime import CONFIG, HUB, ApiError, log_line


class CoreMixin:

    def api_meta(self, _match, _query):
        self.require(
            "page.overview", "page.progress", "page.volume", "page.trend",
            "page.dashboard", "page.waves", "page.orders", "page.labor",
            "page.alerts", "page.screen",
        )
        rows = self.conn.execute("SELECT COUNT(*) AS c FROM source_files").fetchone()
        return self.json_out(
            {
                "site_title": CONFIG.get("site_title"),
                "version": db.get_version(self.conn),
                "biz_dates": rules.biz_dates(self.conn),
                "default_biz_date": rules.default_biz_date(self.conn),
                "today": db.today_str(),
                "cutoff": CONFIG.get("cutoff_time", "16:00"),
                "last_scan": db.get_meta(self.conn, "last_scan_at", ""),
                "source_dirs": ingest.resolve_dirs(CONFIG),
                "files": rows["c"] or 0,
                "scan_sec": CONFIG.get("scan_sec", 60),
                "data_range": rules.data_range(self.conn),
                "archived_dates": [x["biz_date"] for x in archive.list_dates(self.conn)],
                "permissions": sorted(self.perms),
            }
        )

    def api_overview(self, _match, query):
        self.require("page.overview")
        date = self.biz_date(query)
        self.json_out(rules.overview(self.conn, date, self.user["id"], self.with_amount()))

    def api_progress(self, _match, query):
        self.require("page.progress")
        date = self.biz_date(query)
        self.json_out(
            rules.progress(
                self.conn, date, self.user["id"], self.with_amount(),
                CONFIG.get("cutoff_time", "16:00"),
            )
        )

    def api_volume(self, _match, query):
        self.require("page.volume")
        date = self.biz_date(query)
        period = (query.get("period") or ["today"])[0].strip()
        self.json_out(rules.volume_period(self.conn, date, period, self.user["id"], self.with_amount()))

    def api_trend(self, _match, query):
        self.require("page.trend")
        try:
            days = int((query.get("days") or ["30"])[0])
        except ValueError:
            days = 30
        data = rules.trend(self.conn, days)
        if not self.with_amount():
            data["amount"] = [None for _ in data["amount"]]
        self.json_out(data)

    def api_orders(self, _match, query):
        self.require("page.volume", "page.progress")
        date = self.biz_date(query)
        self.json_out(
            rules.orders_page(
                self.conn, date, self.user["id"], self.with_amount(),
                q=(query.get("q") or [""])[0],
                route=(query.get("route") or [""])[0],
                zone=(query.get("zone") or [""])[0],
                page=(query.get("page") or ["1"])[0],
                size=(query.get("size") or ["50"])[0],
            )
        )

    def api_summary(self, _match, query):
        """单量表同口径交叉表：承运商/线路 × 库区。"""
        self.require("page.volume", "page.progress", "action.export")
        date = self.biz_date(query)
        self.json_out(rules.summary_matrix(self.conn, date, self.user["id"], self.with_amount()))

    def api_sources(self, _match, query):
        self.require("page.sources")
        try:
            file_page = max(1, int((query.get("file_page") or ["1"])[0]))
        except ValueError:
            file_page = 1
        try:
            file_page_size = max(1, min(50, int((query.get("file_page_size") or ["10"])[0])))
        except ValueError:
            file_page_size = 10
        group_files = (query.get("file_group") or ["0"])[0] == "1"
        all_files = []
        for r in self.conn.execute("SELECT * FROM source_files ORDER BY imported_at DESC, id DESC"):
            item = {
                "id": r["id"],
                "name": r["name"],
                "kind": r["kind"],
                "rows": r["rows"],
                "status": r["status"],
                "error": r["error"],
                "imported_at": r["imported_at"],
                "size": r["size"],
                "biz_dates": (r["biz_dates"] or "").strip(),
                "exists": os.path.isfile(r["path"] or ""),
                "logical_key": source_archive.logical_file_key(r["name"] or ""),
            }
            rdate = re.search(r"(\d{4}-\d{2}-\d{2})", item["name"] or "")
            item["content_date_mismatch"] = bool(
                rdate and item["biz_dates"] and rdate.group(1) not in
                [x.strip() for x in item["biz_dates"].split(",") if x.strip()]
            )
            all_files.append(item)
        if group_files:
            grouped = {}
            for item in all_files:
                key = item["logical_key"]
                if key not in grouped:
                    grouped[key] = dict(item, versions=1)
                else:
                    grouped[key]["versions"] = grouped[key].get("versions", 1) + 1
            file_total = len(grouped)
            files = list(grouped.values())
        else:
            file_total = len(all_files)
            files = all_files
        file_pages = max(1, (file_total + file_page_size - 1) // file_page_size)
        file_page = min(file_page, file_pages)
        start = (file_page - 1) * file_page_size
        files = files[start : start + file_page_size]
        dirs = ingest.resolve_dirs(CONFIG)
        registered = rules.biz_dates(self.conn)
        target = registered[0]["biz_date"] if registered else rules.default_biz_date(self.conn)
        tms = sorted(
            {r["wave_no"] for r in self.conn.execute(
                "SELECT wave_no FROM wave_registry WHERE biz_date=? AND deleted_at IS NULL", (target,)
            )}
            - {r["wave_no"] for r in self.conn.execute("SELECT wave_no FROM tms_status")}
        )
        unmapped = self._unmapped_dealers()
        self.json_out(
            {
                "dirs": [{"path": d, "ok": os.path.isdir(d)} for d in dirs],
                "files": files,
                "file_total": file_total,
                "file_pages": file_pages,
                "file_page": file_page,
                "file_page_size": file_page_size,
                "last_scan": db.get_meta(self.conn, "last_scan_at", ""),
                "last_scan_error": db.get_meta(self.conn, "last_scan_error", ""),
                "scan_sec": CONFIG.get("scan_sec", 60),
                "tms_unmatched": tms,
                "unmapped": unmapped[:200],
                "unmapped_count": len(unmapped),
                "data_range": rules.data_range(self.conn),
                "archived_dates": archive.list_dates(self.conn),
            }
        )

    def api_source_archives(self, _match, query):
        """扫描文件归档列表。"""
        self.require("page.sources")
        kind = (query.get("kind") or ["all"])[0]
        q = (query.get("q") or [""])[0].strip()
        self.json_out(
            source_archive.list_archives(
                self.conn, kind=kind, q=q,
                date_from=(query.get("from") or [""])[0].strip(),
                date_to=(query.get("to") or [""])[0].strip(),
            )
        )

    def api_source_archive_preview(self, match, query):
        self.require("page.sources")
        limit = (query.get("limit") or [str(source_archive.PREVIEW_ROWS)])[0]
        data = source_archive.preview(self.conn, int(match.group(1)), limit)
        if not data:
            raise ApiError(404, "归档不存在或已被清理")
        self.json_out(data)

    def api_scan(self, _match, _query):
        self.require("action.scan")
        before = db.get_version(self.conn)
        try:
            report = ingest.scan(self.conn, CONFIG, force=True, wait=True)
        except Exception as exc:  # noqa: BLE001
            db.set_meta(self.conn, "last_scan_error", "%s %s" % (db.now_str(), exc))
            log_line("手动扫描失败\n%s" % traceback.format_exc())
            raise ApiError(500, "扫描失败：%s" % exc)
        if report.get("busy"):
            self.json_out({"ok": False, "busy": True, "error": "已有一轮扫描正在进行，请稍后再试"})
            return
        db.set_meta(self.conn, "last_scan_at", db.now_str())
        db.set_meta(self.conn, "last_scan_error", "；".join(report.get("errors") or []) or "")
        try:
            report["archived"] = archive_refresh.refresh(self.conn, report, self.user)
        except Exception:  # noqa: BLE001
            log_line("自动归档失败\n%s" % traceback.format_exc())
            report["archived"] = {"orders": [], "labor": [], "orders_filled": [], "labor_filled": []}
        try:
            report["archive_cleanup"] = source_archive.cleanup(self.conn)
        except Exception:  # noqa: BLE001
            log_line("归档清理失败\n%s" % traceback.format_exc())
        report["archives"] = source_archive.summary(self.conn)
        after = db.get_version(self.conn)
        if after != before:
            HUB.broadcast(after)
        db.audit(self.conn, self.user, self.client_ip(), "scan", "", json.dumps(report, ensure_ascii=False))
        self.json_out(report)
