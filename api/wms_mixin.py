# -*- coding: utf-8 -*-
"""WMS 自动下载管理"""

from backend.archives import archive_refresh
from backend.archives import source_archive
from backend.collect import ingest
from backend.core import db
import json
import os
import re
import threading
import traceback
from urllib.parse import unquote
from backend.wms import ingest_token
from backend.wms import wms_manage

from api.runtime import CONFIG, HUB, ApiError, log_line

UPLOAD_LIMIT = 32 * 1024 * 1024
UPLOAD_EXTS = (".xlsx", ".xlsm", ".csv")
UPLOAD_NAME_MAX = 200


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

    def api_wms_download_sync(self, _match, _query):
        self.require("action.scan")
        try:
            result = wms_manage.sync_now()
            db.audit(self.conn, self.user, self.client_ip(), "wms.sync", "WMS自动下载", "手动补传服务器")
            self.json_out(result)
        except wms_manage.WmsError as exc:
            self._wms_error(exc)

    def api_wms_download_log(self, _match, query):
        self.require("page.sources")
        try:
            tail = int((query.get("tail") or ["200"])[0])
        except ValueError:
            tail = 200
        self.json_out(wms_manage.logs(tail))

    # ------------------------------------------------------------ 上传即入库
    def handle_ingest_upload_public(self):
        """下载机用机器令牌直接上传文件，落地后立即扫描入库（不走 Cookie 会话）。"""
        if self.conn is None:
            self.conn = db.connect()
        ip = self.client_ip()
        raw = self.read_body(limit=UPLOAD_LIMIT)
        name = self._upload_name()
        verdict = ingest_token.verify(self.conn, self.headers.get("X-WMS-Token"))
        if verdict is None:
            raise ApiError(503, "未配置上传令牌，请先在 WMS 面板生成")
        if not verdict:
            db.audit(self.conn, None, ip, "ingest.upload.fail", name, "令牌错误")
            raise ApiError(401, "上传令牌不正确")
        if not raw:
            raise ApiError(400, "没有文件内容")

        dirs = ingest.resolve_dirs(CONFIG)
        if not dirs:
            raise ApiError(500, "没有可用的数据源目录，无法接收上传")
        target = os.path.join(dirs[0], name)
        if self._same_content(target, raw):
            # 内容与已有文件一致且已成功入库过：不重写、不重扫，避免白跑一次导入
            row = self.conn.execute(
                "SELECT name, rows, status, error, imported_at FROM source_files WHERE path=?",
                (target,),
            ).fetchone()
            if row and row["status"] == "ok":
                ingest_token.mark_upload(self.conn, name)
                db.audit(self.conn, None, ip, "ingest.upload.skip", name,
                         "内容未变化，跳过（%s 字节）" % len(raw))
                self.json_out({
                    "ok": True,
                    "queued": False,
                    "skipped": True,
                    "name": name,
                    "size": len(raw),
                    "report": {"imported": 0, "updated": 0, "skipped": 1,
                               "added_rows": 0, "removed_stale_rows": 0,
                               "files": [], "errors": []},
                    "source_file": dict(row),
                })
                return
        self._atomic_write(target, raw)

        try:
            report = ingest.scan(self.conn, CONFIG, force=False, wait=True)
        except Exception as exc:  # noqa: BLE001
            db.set_meta(self.conn, "last_scan_error", "%s %s" % (db.now_str(), exc))
            log_line("上传后扫描失败\n%s" % traceback.format_exc())
            db.audit(self.conn, None, ip, "ingest.upload.fail", name, "扫描失败：%s" % exc)
            raise ApiError(500, "扫描失败：%s" % exc)
        if report.get("busy"):
            ingest_token.mark_upload(self.conn, name)
            db.audit(self.conn, None, ip, "ingest.upload.queued", name, "已接收，等待后台扫描")
            self.json_out({"ok": True, "queued": True, "name": name, "size": len(raw),
                           "message": "已接收，后台扫描完成后自动入库"})
            return

        db.set_meta(self.conn, "last_scan_at", db.now_str())
        db.set_meta(self.conn, "last_scan_error", "；".join(report.get("errors") or []) or "")
        try:
            report["archived"] = archive_refresh.refresh(self.conn, report, None)
        except Exception:  # noqa: BLE001
            log_line("上传后自动归档失败\n%s" % traceback.format_exc())
            report["archived"] = {"orders": [], "labor": [], "orders_filled": [], "labor_filled": []}
        try:
            source_archive.cleanup(self.conn)
        except Exception:  # noqa: BLE001
            log_line("上传后归档清理失败\n%s" % traceback.format_exc())
        HUB.broadcast(db.get_version(self.conn))
        ingest_token.mark_upload(self.conn, name)
        row = self.conn.execute(
            "SELECT name, rows, status, error, imported_at FROM source_files WHERE path=?",
            (target,),
        ).fetchone()
        db.audit(self.conn, None, ip, "ingest.upload", name,
                 "size=%s imported=%s updated=%s skipped=%s errors=%s"
                 % (len(raw), report.get("imported"), report.get("updated"),
                    report.get("skipped"), "；".join(report.get("errors") or [])))
        self.json_out({
            "ok": True,
            "queued": False,
            "name": name,
            "size": len(raw),
            "report": {
                "imported": report.get("imported"),
                "updated": report.get("updated"),
                "skipped": report.get("skipped"),
                "added_rows": report.get("added_rows"),
                "removed_stale_rows": report.get("removed_stale_rows"),
                "files": report.get("files"),
                "errors": report.get("errors"),
            },
            "source_file": dict(row) if row else None,
        })

    def _upload_name(self):
        """从 X-File-Name 取文件名并做安全校验，非法直接 400。"""
        raw = unquote(self.headers.get("X-File-Name") or "").strip()
        if not raw:
            raise ApiError(400, "缺少 X-File-Name 请求头")
        if len(raw) > UPLOAD_NAME_MAX:
            raise ApiError(400, "文件名过长")
        if "/" in raw or "\\" in raw or raw in (".", "..") or raw.startswith("."):
            raise ApiError(400, "文件名不合法：%s" % raw)
        ext = os.path.splitext(raw)[1].lower()
        if ext not in UPLOAD_EXTS:
            raise ApiError(400, "不支持的文件类型：%s（只接受 xlsx/xlsm/csv）" % (ext or "(无扩展名)"))
        return raw

    def _same_content(self, target, raw):
        """目标文件已存在且字节完全一致时返回 True（用于跳过重复上传）。"""
        try:
            if os.path.getsize(target) != len(raw):
                return False
            with open(target, "rb") as fh:
                return fh.read() == raw
        except OSError:
            return False

    def _atomic_write(self, target, raw):
        """先写 .part-* 再 os.replace，扫描器永远看不到半截文件。"""
        folder = os.path.dirname(target)
        try:
            os.makedirs(folder, exist_ok=True)
            tmp = "%s.part-%s-%s" % (target, os.getpid(), threading.get_ident())
            with open(tmp, "wb") as fh:
                fh.write(raw)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, target)
        except OSError as exc:
            try:
                if os.path.isfile(tmp):
                    os.remove(tmp)
            except (OSError, UnboundLocalError):
                pass
            raise ApiError(500, "写入数据源目录失败：%s" % exc)

    def api_wms_ingest_token_get(self, _match, _query):
        self.require("action.scan")
        self.json_out(ingest_token.status(self.conn))

    def api_wms_ingest_token_rotate(self, _match, _query):
        self.require("action.scan")
        result = ingest_token.rotate(self.conn)
        db.audit(self.conn, self.user, self.client_ip(), "ingest.token.rotate", "上传令牌",
                 "created_at=%s" % result.get("created_at"))
        self.json_out({"ok": True, "token": result["token"], "created_at": result["created_at"]})

    def _wms_state(self, tail=200):
        return wms_manage.state(self.conn, tail=tail)

    def _wms_error(self, exc):
        raise ApiError(getattr(exc, "status", 500), str(exc))
