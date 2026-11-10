# -*- coding: utf-8 -*-
"""HTTP 服务：静态页 + REST API + SSE 实时推送 + 登录与权限网关。

启动：python server.py            （读取 config.json）
      python server.py --port 9000
"""
import csv
import hashlib
import io
import json
import os
import queue
import re
import shutil
import sys
import threading
import tempfile
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import archive
import archive_refresh
import alerts
import auth
import battery
import battery_archive
import config_loader
import db
import ingest
import labor_archive
import perms
import rules
import source_archive
import outbound_archive
import templates
import widgets
import wms_manage

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
LOG_PATH = os.path.join(BASE_DIR, "data", "server.log")
CONFIG = config_loader.load()
COOKIE_NAME = "dash_session"
STATIC_FILES = {"index.html", "app.js", "charts.js", "grid.js", "styles.css", "favicon.svg"}
MUTATING = {"POST", "PUT", "DELETE", "PATCH"}


# ---------------------------------------------------------------- 日志
_log_lock = threading.Lock()


def log_line(message):
    line = "[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), message)
    with _log_lock:
        try:
            os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
            with open(LOG_PATH, "a", encoding="utf-8") as fh:
                fh.write(line)
        except Exception:
            pass
        sys.stderr.write(line)


# ---------------------------------------------------------------- 广播
class Hub:
    def __init__(self):
        self._lock = threading.Lock()
        self._clients = []

    def register(self):
        q = queue.Queue(maxsize=32)
        with self._lock:
            self._clients.append(q)
        return q

    def unregister(self, q):
        with self._lock:
            if q in self._clients:
                self._clients.remove(q)

    def broadcast(self, version):
        with self._lock:
            clients = list(self._clients)
        for q in clients:
            try:
                q.put_nowait(version)
            except queue.Full:
                pass


HUB = Hub()


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------- 模板与初始化
def ensure_default_dashboards(conn):
    """自定义画布的示例公共看板（page_key 为空）。"""
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM dashboards WHERE owner_user_id IS NULL AND page_key IS NULL"
    ).fetchone()
    if (row["c"] or 0) > 0:
        return
    for tpl in templates.TEMPLATES:
        layout = json.dumps({"widgets": tpl["widgets"]}, ensure_ascii=False)
        conn.execute(
            "INSERT INTO dashboards(name, owner_user_id, visibility, is_default, layout_json, version, updated_at) "
            "VALUES(?,NULL,'shared',?,?,1,?)",
            (tpl["name"], tpl.get("is_default", 0), layout, db.now_str()),
        )


PAGE_TEMPLATES = {item["key"]: item for item in templates.PAGE_TEMPLATES}


def ensure_page_dashboards(conn):
    """为每个导航页种下公共默认看板（只补缺，不覆盖已发布的版本）。"""
    for item in templates.PAGE_TEMPLATES:
        row = conn.execute(
            "SELECT id FROM dashboards WHERE page_key=? AND owner_user_id IS NULL",
            (item["key"],),
        ).fetchone()
        if row:
            continue
        layout = json.dumps({"widgets": item["widgets"]}, ensure_ascii=False)
        conn.execute(
            "INSERT INTO dashboards(name, owner_user_id, visibility, is_default, layout_json, "
            "version, updated_at, page_key) VALUES(?,NULL,'shared',1,?,1,?,?)",
            (item["name"], layout, db.now_str(), item["key"]),
        )


def ensure_personal_page_layouts(conn):
    """个人页面布局里还残留按组指标时，换成该页新的默认布局（保留"我的布局"）。"""
    for row in conn.execute(
        "SELECT id, page_key, layout_json FROM dashboards "
        "WHERE page_key IS NOT NULL AND owner_user_id IS NOT NULL"
    ).fetchall():
        raw = row["layout_json"] or ""
        if not any(token in raw for token in GROUP_METRICS):
            continue
        template = next(
            (item for item in templates.PAGE_TEMPLATES if item["key"] == row["page_key"]), None
        )
        if not template:
            continue
        layout = json.dumps({"widgets": template["widgets"]}, ensure_ascii=False)
        conn.execute(
            "UPDATE dashboards SET layout_json=?, version=version+1, updated_at=? WHERE id=?",
            (layout, db.now_str(), row["id"]),
        )


def ensure_erp_detail_filters(conn):
    """一次性修复历史布局里 erp_detail 组件丢失的 filter.erp_status。"""
    if db.get_meta(conn, "erp_filter_repair_v1") == "1":
        return
    repaired = []
    for row in conn.execute(
        "SELECT id, page_key, owner_user_id, layout_json FROM dashboards"
    ).fetchall():
        try:
            layout = json.loads(row["layout_json"] or "{}")
        except ValueError:
            continue
        changed = False
        for widget in layout.get("widgets") or []:
            spec = widget.get("spec") or {}
            if spec.get("dataset") != "erp_detail":
                continue
            filt = spec.get("filter") or {}
            if filt.get("erp_status") in ("failed", "missing"):
                continue
            label = "%s %s" % (widget.get("id") or "", widget.get("title") or "")
            status = "missing" if ("未回传" in label or "missing" in label) else "failed"
            filt["erp_status"] = status
            spec["filter"] = filt
            spec["dimension"] = ""
            spec["metrics"] = ["rows"]
            widget["spec"] = spec
            changed = True
            repaired.append((row["page_key"] or "dash%s" % row["id"], widget.get("title") or widget.get("id")))
        if changed:
            conn.execute(
                "UPDATE dashboards SET layout_json=?, version=version+1, updated_at=? WHERE id=?",
                (json.dumps(layout, ensure_ascii=False), db.now_str(), row["id"]),
            )
    db.set_meta(conn, "erp_filter_repair_v1", "1")
    if repaired:
        db.audit(conn, None, "", "erp_filter.repair", "layout", json.dumps(repaired, ensure_ascii=False))


def ensure_personal_erp_widgets(conn):
    """一次性把新增的 ERP 组件追加到个人页面布局底部（不动原有组件）。

    只跑一次（meta 标记），之后用户删掉也不会再加回来。
    """
    if db.get_meta(conn, "personal_erp_v9") == "1":
        return
    templates_by_key = {item["key"]: item["widgets"] for item in templates.PAGE_TEMPLATES}
    for row in conn.execute(
        "SELECT id, page_key, layout_json FROM dashboards "
        "WHERE page_key IN ('overview', 'progress') AND owner_user_id IS NOT NULL"
    ).fetchall():
        try:
            layout = json.loads(row["layout_json"] or "{}")
        except ValueError:
            continue
        widgets = layout.get("widgets") or []
        existing = {w.get("id") for w in widgets}
        default_widgets = templates_by_key.get(row["page_key"]) or []
        new_widgets = [
            w for w in default_widgets
            if str(w.get("id", "")).startswith("pg-%s-erp" % ("ov" if row["page_key"] == "overview" else "pr"))
            and w.get("id") not in existing
        ]
        if not new_widgets:
            continue
        bottom = 0
        for w in widgets:
            bottom = max(bottom, int(w.get("y") or 0) + int(w.get("h") or 3))
        for w in new_widgets:
            copy = json.loads(json.dumps(w))
            copy["x"] = 0
            copy["w"] = 12
            copy["y"] = bottom
            bottom += int(copy.get("h") or 5)
            widgets.append(copy)
        layout["widgets"] = widgets
        conn.execute(
            "UPDATE dashboards SET layout_json=?, version=version+1, updated_at=? WHERE id=?",
            (json.dumps(layout, ensure_ascii=False), db.now_str(), row["id"]),
        )
    db.set_meta(conn, "personal_erp_v9", "1")


def ensure_page_layouts_v9(conn):
    """v9：总览/进度补 ERP 回传组件（只在仍是旧默认时替换）。"""
    if _page_layout_version(conn) >= 9:
        return
    sentinels = {
        "overview": ("pg-ov-cycle", "pg-ov-erp-failed", templates.PAGE_OVERVIEW),
        "progress": ("pg-pr-tms", "pg-pr-erp-failed", templates.PAGE_PROGRESS),
    }
    for key, (old_id, new_id, template) in sentinels.items():
        row = conn.execute(
            "SELECT * FROM dashboards WHERE page_key=? AND owner_user_id IS NULL", (key,)
        ).fetchone()
        if not row:
            continue
        try:
            widget_ids = {w.get("id") for w in json.loads(row["layout_json"] or "{}").get("widgets", [])}
        except ValueError:
            widget_ids = set()
        if old_id in widget_ids and new_id not in widget_ids:
            layout = json.dumps({"widgets": template}, ensure_ascii=False)
            conn.execute(
                "UPDATE dashboards SET layout_json=?, version=version+1, updated_at=? WHERE id=?",
                (layout, db.now_str(), row["id"]),
            )
    db.set_meta(conn, "page_layout_version", "9")


def _page_layout_version(conn):
    try:
        return int(db.get_meta(conn, "page_layout_version") or 0)
    except (TypeError, ValueError):
        return 0


GROUP_METRICS = {"groups", "all_groups", "registered_today_groups", "unregistered_groups"}


def ensure_page_layouts_v8(conn):
    """v8：取消所有按组统计的组件指标。

    - 页面默认布局里只要还残留组指标，就换成新模板（3 行 KPI：今日订单量/金额、已组波、待组波）
    - 自定义专题看板：从 metrics 里剔除组指标，标题里的"订单组数"等顺手改成行数口径
    """
    ensure_personal_page_layouts(conn)
    if _page_layout_version(conn) >= 8:
        return
    for item in templates.PAGE_TEMPLATES:
        row = conn.execute(
            "SELECT * FROM dashboards WHERE page_key=? AND owner_user_id IS NULL", (item["key"],)
        ).fetchone()
        if not row:
            continue
        raw = row["layout_json"] or ""
        if any(token in raw for token in GROUP_METRICS):
            layout = json.dumps({"widgets": item["widgets"]}, ensure_ascii=False)
            conn.execute(
                "UPDATE dashboards SET layout_json=?, version=version+1, updated_at=? WHERE id=?",
                (layout, db.now_str(), row["id"]),
            )
    rename = {"订单组数": "行数", "今日订单量(组)": "今日订单量(行)", "已登记(组)": "已组波行数",
              "漏登记(组)": "待组波行数"}
    for row in conn.execute(
        "SELECT id, layout_json FROM dashboards WHERE page_key IS NULL"
    ).fetchall():
        try:
            layout = json.loads(row["layout_json"] or "{}")
        except ValueError:
            continue
        changed = False
        for widget in layout.get("widgets") or []:
            spec = widget.get("spec") or {}
            metrics = spec.get("metrics")
            if isinstance(metrics, list):
                kept = [m for m in metrics if m not in GROUP_METRICS]
                if len(kept) != len(metrics):
                    spec["metrics"] = kept or ["rows"]
                    changed = True
            title = widget.get("title") or ""
            for old, new in rename.items():
                if old in title:
                    widget["title"] = title.replace(old, new)
                    changed = True
                    break
        if changed:
            conn.execute(
                "UPDATE dashboards SET layout_json=?, version=version+1, updated_at=? WHERE id=?",
                (json.dumps(layout, ensure_ascii=False), db.now_str(), row["id"]),
            )
    db.set_meta(conn, "page_layout_version", "8")


def ensure_page_layouts_v7(conn):
    """v7：总览/进度默认布局补上 未拣货行数 / 拣货完成率 / 人均每小时拣货行数。

    只在页面仍是旧默认（含旧哨兵组件、缺新组件）时替换，避免覆盖管理员自定义过的布局。
    """
    if _page_layout_version(conn) >= 7:
        return
    targets = {
        "overview": ("pg-ov-unreg", "pg-ov-unpicked", templates.PAGE_OVERVIEW),
        "progress": ("pg-pr-unchecked", "pg-pr-unpicked", templates.PAGE_PROGRESS),
    }
    for key, (old_id, new_id, template) in targets.items():
        row = conn.execute(
            "SELECT * FROM dashboards WHERE page_key=? AND owner_user_id IS NULL", (key,)
        ).fetchone()
        if not row:
            continue
        try:
            widget_ids = {w.get("id") for w in json.loads(row["layout_json"] or "{}").get("widgets", [])}
        except ValueError:
            widget_ids = set()
        if old_id in widget_ids and new_id not in widget_ids:
            layout = json.dumps({"widgets": template}, ensure_ascii=False)
            conn.execute(
                "UPDATE dashboards SET layout_json=?, version=version+1, updated_at=? WHERE id=?",
                (layout, db.now_str(), row["id"]),
            )
    db.set_meta(conn, "page_layout_version", "7")


def ensure_page_layouts_v6(conn):
    """v6：把「人工作业量」默认布局升级为"拣货/复核分开"的版本。

    只在它仍是 v5 默认布局（含 pg-lb-people）时替换，避免覆盖管理员自己发布过的版本。
    """
    if _page_layout_version(conn) >= 6:
        return
    row = conn.execute(
        "SELECT * FROM dashboards WHERE page_key='labor' AND owner_user_id IS NULL"
    ).fetchone()
    if row:
        try:
            widget_ids = {w.get("id") for w in json.loads(row["layout_json"] or "{}").get("widgets", [])}
        except ValueError:
            widget_ids = set()
        if "pg-lb-people" in widget_ids:
            layout = json.dumps({"widgets": templates.PAGE_LABOR}, ensure_ascii=False)
            conn.execute(
                "UPDATE dashboards SET layout_json=?, version=version+1, updated_at=? WHERE id=?",
                (layout, db.now_str(), row["id"]),
            )
    db.set_meta(conn, "page_layout_version", "6")


def ensure_user_dashboards(conn, user_id):
    """给用户一份自由画布的初始副本（页面看板不走这里）。"""
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM dashboards WHERE owner_user_id=? AND page_key IS NULL",
        (user_id,),
    ).fetchone()
    if (row["c"] or 0) > 0:
        return
    default = conn.execute(
        "SELECT * FROM dashboards WHERE owner_user_id IS NULL AND page_key IS NULL "
        "ORDER BY is_default DESC, id LIMIT 1"
    ).fetchone()
    if default:
        conn.execute(
            "INSERT INTO dashboards(name, owner_user_id, visibility, is_default, layout_json, version, updated_at) "
            "VALUES(?,?,'private',1,?,1,?)",
            (default["name"], user_id, default["layout_json"], db.now_str()),
        )


# ---------------------------------------------------------------- Handler
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "OpsDashboard/1.0"
    conn = None
    user = None
    perms = frozenset()

    # ---------- 基础输出
    def log_message(self, fmt, *args):
        pass

    def handle_one_request(self):
        """客户端（或端口探测）突然断开时不要往日志里刷堆栈。"""
        try:
            BaseHTTPRequestHandler.handle_one_request(self)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError):
            self.close_connection = True

    def client_ip(self):
        forwarded = self.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return self.client_address[0] if self.client_address else ""

    def _send(self, status, body=b"", content_type="application/json; charset=utf-8", headers=None,
              cache_control="no-store"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache_control)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; "
            "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
        )
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if body:
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def json_out(self, obj, status=200, headers=None):
        body = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
        self._send(status, body, headers=headers)

    def error_out(self, status, message):
        self.json_out({"error": message}, status)

    def cookie_token(self):
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            if "=" in part:
                key, value = part.split("=", 1)
                if key.strip() == COOKIE_NAME:
                    return value.strip()
        return None

    def read_body(self, limit=8 * 1024 * 1024):
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            raise ApiError(413, "请求体过大")
        return self.rfile.read(length) if length else b""

    def read_json(self):
        raw = self.read_body()
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            raise ApiError(400, "请求体不是合法 JSON")

    # ---------- 入口
    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def do_PUT(self):
        self.handle_any("PUT")

    def do_DELETE(self):
        self.handle_any("DELETE")

    def handle_any(self, method):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)

        try:
            self.conn = db.connect()
            self.user = None
            self.perms = frozenset()

            token = self.cookie_token()
            if token:
                self.user = auth.session_user(self.conn, token, int(CONFIG.get("session_hours", 12)))

            if path.startswith("/api/"):
                self.dispatch_api(method, path, query)
            else:
                self.serve_static(path)
        except ApiError as exc:
            self.error_out(exc.status, exc.message)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            log_line("未处理异常 %s %s\n%s" % (method, self.path, traceback.format_exc()))
            try:
                self.error_out(500, "服务端错误：%s" % exc)
            except Exception:
                pass

    # ---------- 静态文件
    def serve_static(self, path):
        name = "index.html" if path in ("/", "") else path.lstrip("/")
        if name not in STATIC_FILES:
            self._send(404, b"Not Found", "text/plain; charset=utf-8")
            return
        full = os.path.join(WEB_DIR, name)
        if not os.path.isfile(full):
            self._send(404, b"Not Found", "text/plain; charset=utf-8")
            return
        content_types = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml",
        }
        ext = os.path.splitext(name)[1].lower()
        with open(full, "rb") as fh:
            data = fh.read()
        # 入口页每次校验；其余带 ?v= 版本号的静态资源缓存一天，并用 ETag 支持 304
        is_entry = name == "index.html"
        cache_control = "no-cache" if is_entry else "public, max-age=86400"
        etag = '"%s"' % hashlib.md5(data).hexdigest()[:16]
        if not is_entry and self.headers.get("If-None-Match") == etag:
            self._send(304, b"", content_types.get(ext, "application/octet-stream"),
                       {"ETag": etag}, cache_control=cache_control)
            return
        self._send(200, data, content_types.get(ext, "application/octet-stream"),
                   {"ETag": etag}, cache_control=cache_control)

    # ---------- 鉴权
    def authenticated(self):
        return self.user is not None

    def require_login(self):
        if not self.user:
            raise ApiError(401, "未登录")
        self.perms = auth.effective_permissions(self.conn, self.user["id"])

    def require(self, *codes):
        """任一权限命中即可。"""
        if not auth.require(self.perms, *codes):
            raise ApiError(403, "没有权限执行该操作")

    def with_amount(self):
        return "field.amount" in self.perms

    def form_amount_guard(self, spec):
        """无金额权限时，主动把 amount 指标剔除。"""
        if self.with_amount():
            return spec
        spec = dict(spec or {})
        metrics = [m for m in (spec.get("metrics") or []) if m != "amount"]
        spec["metrics"] = metrics or ["rows"]
        return spec

    # ---------- API 分发
    def dispatch_api(self, method, path, query):
        setup_mode = not auth.has_users(self.conn)

        # 公开接口
        if path == "/api/health":
            self.json_out({"ok": True, "time": db.now_str()})
            return
        if path == "/api/me":
            self.json_out(self.me_payload(setup_mode))
            return
        if path == "/api/setup" and method == "POST":
            self.handle_setup()
            return
        if path == "/api/login" and method == "POST":
            self.handle_login()
            return
        if setup_mode:
            raise ApiError(401, "系统尚未初始化，请先创建管理员账号")
        if path == "/api/events":
            self.handle_sse(query)
            return

        self.require_login()

        # 默认口令/临时口令必须先改密，避免公网暴露时长期使用弱口令
        if self.user["pwd_is_default"] or self.user["must_change_pwd"]:
            if path not in ("/api/logout", "/api/change-password"):
                raise ApiError(428, "请先修改初始密码")

        if method in MUTATING and self.headers.get("X-Dashboard-Client") != "1":
            raise ApiError(403, "缺少客户端标识，拒绝写操作")

        if path == "/api/logout" and method == "POST":
            self.handle_logout()
            return
        if path == "/api/change-password" and method == "POST":
            self.handle_change_password()
            return

        handlers = [
            ("GET", r"^/api/meta$", self.api_meta),
            ("GET", r"^/api/overview$", self.api_overview),
            ("GET", r"^/api/progress$", self.api_progress),
            ("GET", r"^/api/volume$", self.api_volume),
            ("GET", r"^/api/trend$", self.api_trend),
            ("GET", r"^/api/orders$", self.api_orders),
            ("GET", r"^/api/summary$", self.api_summary),
            ("GET", r"^/api/sources$", self.api_sources),
            ("POST", r"^/api/scan$", self.api_scan),
            ("GET", r"^/api/waves$", self.api_waves_list),
            ("POST", r"^/api/waves$", self.api_waves_create),
            ("PUT", r"^/api/waves/(\d+)$", self.api_waves_update),
            ("DELETE", r"^/api/waves/(\d+)$", self.api_waves_delete),
            ("GET", r"^/api/waves/candidates$", self.api_waves_candidates),
            ("GET", r"^/api/waves/(\d+)/orders$", self.api_wave_orders),
            ("GET", r"^/api/order-groups$", self.api_order_groups),
            ("PUT", r"^/api/order-groups/([^/]+)$", self.api_order_group_save),
            ("DELETE", r"^/api/order-groups/([^/]+)$", self.api_order_group_reset),
            ("GET", r"^/api/battery/rows$", self.api_battery_rows),
            ("POST", r"^/api/battery/confirm$", self.api_battery_confirm),
            ("POST", r"^/api/battery/unconfirm$", self.api_battery_unconfirm),
            ("POST", r"^/api/battery/parts/import$", self.api_battery_parts_import),
            ("GET", r"^/api/battery/parts$", self.api_battery_parts),
            ("GET", r"^/api/battery/dealers$", self.api_battery_dealers),
            ("GET", r"^/api/export/battery.csv$", self.api_export_battery),
            ("POST", r"^/api/battery/dealers$", self.api_battery_dealer_save),
            ("GET", r"^/api/battery/archive/list$", self.api_battery_archive_list),
            ("GET", r"^/api/battery/archive$", self.api_battery_archive_query),
            ("POST", r"^/api/battery/archive$", self.api_battery_archive_save),
            ("GET", r"^/api/export/battery-archive.csv$", self.api_export_battery_archive),
            ("GET", r"^/api/archive$", self.api_archive_get),
            ("POST", r"^/api/archive$", self.api_archive_create),
            ("GET", r"^/api/archive/dates$", self.api_archive_dates),
            ("GET", r"^/api/archive/list$", self.api_archive_list),
            ("GET", r"^/api/archive/view$", self.api_archive_view),
            ("GET", r"^/api/export/order-groups.csv$", self.api_export_order_groups),
            ("GET", r"^/api/dealers$", self.api_dealers),
            ("PUT", r"^/api/dealers$", self.api_dealer_save),
            ("POST", r"^/api/dealers/import$", self.api_dealers_import),
            ("GET", r"^/api/dealers/unmapped$", self.api_dealers_unmapped),
            ("GET", r"^/api/dashboards$", self.api_dashboards),
            ("POST", r"^/api/dashboards$", self.api_dashboard_create),
            ("PUT", r"^/api/dashboards/(\d+)$", self.api_dashboard_update),
            ("POST", r"^/api/dashboards/(\d+)/publish$", self.api_dashboard_publish),
            ("DELETE", r"^/api/dashboards/(\d+)$", self.api_dashboard_delete),
            ("GET", r"^/api/pages$", self.api_pages),
            ("GET", r"^/api/pages/([a-z]+)$", self.api_page_get),
            ("PUT", r"^/api/pages/([a-z]+)$", self.api_page_save),
            ("POST", r"^/api/pages/([a-z]+)/reset$", self.api_page_reset),
            ("GET", r"^/api/alerts$", self.api_alerts),
            ("POST", r"^/api/alerts/read$", self.api_alerts_read),
            ("GET", r"^/api/alerts/routes$", self.api_alert_routes),
            ("PUT", r"^/api/alerts/routes$", self.api_alert_routes_save),
            ("GET", r"^/api/alerts/state$", self.api_alert_state),
            ("GET", r"^/api/screen$", self.api_screen),
            ("PUT", r"^/api/screen$", self.api_screen_save),
            ("GET", r"^/api/screen/data$", self.api_screen_data),
            ("GET", r"^/api/labor$", self.api_labor),
            ("POST", r"^/api/labor/archive$", self.api_labor_archive),
            ("GET", r"^/api/labor/archive/dates$", self.api_labor_archive_dates),
            ("POST", r"^/api/labor/rearchive$", self.api_labor_rearchive),
            ("GET", r"^/api/labor/settings$", self.api_labor_settings),
            ("PUT", r"^/api/labor/settings$", self.api_labor_settings_save),
            ("PUT", r"^/api/labor/adjust$", self.api_labor_adjust),
            ("GET", r"^/api/boards$", self.api_boards),
            ("POST", r"^/api/boards/from-page$", self.api_boards_from_page),
            ("POST", r"^/api/boards/cleanup$", self.api_boards_cleanup),
            ("GET", r"^/api/dashboards/(\d+)$", self.api_dashboard_get),
            ("GET", r"^/api/widget-catalog$", self.api_widget_catalog),
            ("POST", r"^/api/widget$", self.api_widget),
            ("GET", r"^/api/coverage/pending-detail$", self.api_pending_detail),
            ("GET", r"^/api/users$", self.api_users),
            ("POST", r"^/api/users$", self.api_user_create),
            ("PUT", r"^/api/users/(\d+)$", self.api_user_update),
            ("POST", r"^/api/users/(\d+)/reset$", self.api_user_reset),
            ("GET", r"^/api/groups$", self.api_groups),
            ("POST", r"^/api/groups$", self.api_group_create),
            ("PUT", r"^/api/groups/(\d+)$", self.api_group_update),
            ("DELETE", r"^/api/groups/(\d+)$", self.api_group_delete),
            ("GET", r"^/api/permissions$", self.api_permissions),
            ("PUT", r"^/api/permissions/group/(\d+)$", self.api_permission_group),
            ("PUT", r"^/api/permissions/user/(\d+)$", self.api_permission_user),
            ("PUT", r"^/api/scopes/(group|user)/(\d+)$", self.api_scope_save),
            ("GET", r"^/api/audit$", self.api_audit),
            ("GET", r"^/api/export/summary.csv$", self.api_export_summary),
            ("GET", r"^/api/export/archive.csv$", self.api_export_archive),
            ("GET", r"^/api/wms-download$", self.api_wms_download_state),
            ("PUT", r"^/api/wms-download/config$", self.api_wms_download_config),
            ("POST", r"^/api/wms-download/run$", self.api_wms_download_run),
            ("GET", r"^/api/wms-download/run$", self.api_wms_download_run_state),
            ("POST", r"^/api/wms-download/run/stop$", self.api_wms_download_stop),
            ("POST", r"^/api/wms-download/schedule$", self.api_wms_download_schedule),
            ("GET", r"^/api/wms-download/log$", self.api_wms_download_log),
            ("GET", r"^/api/outbound-archive/dates$", self.api_outbound_archive_dates),
            ("GET", r"^/api/outbound-archive$", self.api_outbound_archive),
            ("GET", r"^/api/outbound-archive/query$", self.api_outbound_archive_query),
            ("GET", r"^/api/export/outbound-archive.csv$", self.api_export_outbound_archive),
            ("GET", r"^/api/export/unmapped-dealers.csv$", self.api_export_unmapped_dealers),
        ]
        for verb, pattern, handler in handlers:
            if verb != method:
                continue
            match = re.match(pattern, path)
            if match:
                handler(match, query)
                return
        raise ApiError(404, "接口不存在")

    # ================================================================ 登录相关
    def me_payload(self, setup_mode=None):
        site = CONFIG.get("site_title", "单量看板")
        if setup_mode is None:
            setup_mode = not auth.has_users(self.conn)
        if setup_mode:
            return {"setup": True, "authenticated": False, "site_title": site}
        if not self.user:
            return {"setup": False, "authenticated": False, "site_title": site}
        uid = self.user["id"]
        return {
            "setup": False,
            "authenticated": True,
            "site_title": site,
            "user": {
                "id": uid,
                "username": self.user["username"],
                "display_name": self.user["display_name"],
                "must_change_pwd": bool(self.user["must_change_pwd"] or self.user["pwd_is_default"]),
            },
            "permissions": sorted(auth.effective_permissions(self.conn, uid)),
            "scopes": auth.scope_summary(self.conn, uid),
            "is_admin": auth.is_admin(self.conn, uid),
            "unread_alerts": alerts.unread_count(self.conn, uid),
        }

    def set_session_cookie(self, token):
        hours = int(CONFIG.get("session_hours", 12))
        secure = ""
        mode = str(CONFIG.get("cookie_secure", "auto")).lower()
        if mode in ("1", "true", "yes", "on"):
            secure = "; Secure"
        elif mode == "auto":
            proto = (self.headers.get("X-Forwarded-Proto") or "").lower()
            if proto == "https" or (self.headers.get("X-Forwarded-Ssl") or "").lower() == "on":
                secure = "; Secure"
        return {
            "Set-Cookie": "%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d%s"
            % (COOKIE_NAME, token, hours * 3600, secure)
        }

    def handle_setup(self):
        if auth.has_users(self.conn):
            raise ApiError(400, "系统已初始化")
        body = self.read_json()
        username = (body.get("username") or "").strip()
        password = body.get("password") or ""
        display = (body.get("display_name") or "").strip() or "管理员"
        if not re.match(r"^[A-Za-z0-9_.-]{3,32}$", username):
            raise ApiError(400, "用户名 3-32 位，仅字母数字下划线")
        problem = auth.password_problem(password)
        if problem:
            raise ApiError(400, problem)
        auth.ensure_initial_admin(self.conn, username, password, display)
        ensure_default_dashboards(self.conn)
        user = auth.get_user_by_username(self.conn, username)
        token = auth.create_session(self.conn, user["id"], self.client_ip(), self.headers.get("User-Agent"), int(CONFIG.get("session_hours", 12)))
        db.audit(self.conn, user, self.client_ip(), "setup", username, "初始化管理员")
        self.json_out(self.me_payload(False), headers=self.set_session_cookie(token))

    def handle_login(self):
        body = self.read_json()
        username = (body.get("username") or "").strip()
        password = body.get("password") or ""
        if not username or not password:
            raise ApiError(400, "请输入用户名和密码")
        user, err = auth.authenticate(self.conn, username, password, self.client_ip())
        if err:
            db.audit(self.conn, None, self.client_ip(), "login.fail", username, err)
            raise ApiError(401, err)
        token = auth.create_session(self.conn, user["id"], self.client_ip(), self.headers.get("User-Agent"), int(CONFIG.get("session_hours", 12)))
        db.audit(self.conn, user, self.client_ip(), "login.ok", username, "")
        self.user = user
        ensure_default_dashboards(self.conn)
        ensure_page_dashboards(self.conn)
        ensure_user_dashboards(self.conn, user["id"])
        self.json_out(self.me_payload(False), headers=self.set_session_cookie(token))

    def handle_logout(self):
        token = self.cookie_token()
        auth.destroy_session(self.conn, token)
        if self.user:
            db.audit(self.conn, self.user, self.client_ip(), "logout", "", "")
        self.json_out({"ok": True}, headers={"Set-Cookie": COOKIE_NAME + "=; Path=/; Max-Age=0"})

    def handle_change_password(self):
        body = self.read_json()
        old = body.get("old_password") or ""
        new = body.get("new_password") or ""
        if not auth.verify_password(old, self.user["pwd_hash"], self.user["salt"]):
            raise ApiError(400, "原密码不正确")
        problem = auth.password_problem(new)
        if problem:
            raise ApiError(400, problem)
        auth.set_password(self.conn, self.user["id"], new, must_change=0)
        db.audit(self.conn, self.user, self.client_ip(), "change_password", self.user["username"], "")
        self.json_out({"ok": True})

    # ================================================================ 数据
    def biz_date(self, query):
        value = (query.get("date") or [""])[0].strip()
        if re.match(r"^\d{4}-\d{2}-\d{2}$", value):
            return value
        return rules.default_biz_date(self.conn)

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

    # ================================================================ 数据源
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

    def _wms_state(self, tail=200):
        return wms_manage.state(self.conn, tail=tail)

    def _wms_error(self, exc):
        raise ApiError(getattr(exc, "status", 500), str(exc))

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

    def api_export_outbound_archive(self, _match, query):
        self.require("action.export")
        filters = self._outbound_filters(query)
        date = (query.get("date") or [""])[0].strip()
        body = outbound_archive.export_csv(
            self.conn, filters=filters,
            date_col=(query.get("date_col") or [""])[0].strip(),
            date_from=(query.get("from") or [""])[0].strip(),
            date_to=(query.get("to") or [""])[0].strip(),
            biz_date=date or None,
        )
        if body is None:
            raise ApiError(404, "还没有出库文件归档")
        meta = outbound_archive.get_meta(self.conn, date or None) or {}
        db.audit(self.conn, self.user, self.client_ip(), "outbound_archive.export",
                 meta.get("name") or "", "筛选导出")
        filename = os.path.splitext(meta.get("name") or "出库归档")[0] + "_" + (date or "最新") + "_筛选.csv"
        self._send(
            200, body, "text/csv; charset=utf-8",
            {"Content-Disposition": "attachment; filename*=UTF-8''%s" % urllib.parse.quote(filename)},
        )

    def api_export_source_archive(self, _match, query):
        self.require("action.export")
        try:
            archive_id = int((query.get("id") or ["0"])[0])
        except ValueError:
            raise ApiError(400, "归档编号不正确")
        row = source_archive.get(self.conn, archive_id)
        if not row:
            raise ApiError(404, "归档不存在或已被清理")
        body = source_archive.export_csv(self.conn, archive_id)
        if body is None:
            raise ApiError(404, "这条归档没有行数据快照")
        db.audit(self.conn, self.user, self.client_ip(), "source_archive.export",
                 row["name"], "%d 行" % (row["rows"] or 0))
        filename = os.path.splitext(row["name"])[0] + "_行数据.csv"
        self._send(
            200, body, "text/csv; charset=utf-8",
            {"Content-Disposition": "attachment; filename*=UTF-8''%s" % urllib.parse.quote(filename)},
        )

    def _unmapped_dealers(self):
        rows = self.conn.execute(
            "SELECT s.dealer_full AS full_name, COUNT(*) AS lines, COALESCE(SUM(s.amount),0) AS amount "
            "FROM ship_lines s "
            "WHERE s.dealer_full IS NOT NULL AND s.dealer_full <> '' "
            "AND NOT EXISTS (SELECT 1 FROM dealer_lookup d WHERE d.key = s.dealer_full) "
            "GROUP BY s.dealer_full ORDER BY lines DESC"
        ).fetchall()
        result = []
        for r in rows:
            result.append(
                {
                    "full_name": r["full_name"],
                    "lines": r["lines"],
                    "amount": round((r["amount"] or 0) / 10000.0, 2) if self.with_amount() else None,
                }
            )
        return result

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

    # ================================================================ 波次登记
    def api_waves_list(self, _match, query):
        self.require("page.waves")
        date = self.biz_date(query)
        rows = self.conn.execute(
            "SELECT * FROM wave_registry WHERE biz_date=? AND deleted_at IS NULL ORDER BY wave_no",
            (date,),
        ).fetchall()
        data = rules.progress(self.conn, date, self.user["id"], self.with_amount(), CONFIG.get("cutoff_time", "16:00"))
        by_wave = {w["wave_no"]: w for w in data["waves"]}
        result = []
        for r in rows:
            info = by_wave.get(r["wave_no"], {})
            result.append(
                {
                    "id": r["id"],
                    "wave_no": r["wave_no"],
                    "note": r["note"],
                    "carrier_override": r["carrier_override"],
                    "created_at": r["created_at"],
                    "updated_at": r["updated_at"],
                    "groups": info.get("groups", 0),
                    "lines": info.get("lines", 0),
                    "amount": info.get("amount") if self.with_amount() else None,
                    "picked": info.get("picked", 0),
                    "checked": info.get("checked", 0),
                    "out": info.get("out", 0),
                    "rate": info.get("rate", 0.0),
                    "done": info.get("done", False),
                    "pending": info.get("pending", False) or (not info and not rules.wave_has_data(self.conn, r["wave_no"])),
                    "excluded_all": info.get("excluded_all", False),
                    "tms_status": info.get("tms_status"),
                    "tms_carrier": info.get("tms_carrier"),
                }
            )
        self.json_out({"biz_date": date, "rows": result})

    def api_waves_candidates(self, _match, query):
        self.require("page.waves")
        date = self.biz_date(query)
        registered = {
            r["wave_no"]
            for r in self.conn.execute(
                "SELECT wave_no FROM wave_registry WHERE biz_date=? AND deleted_at IS NULL", (date,)
            )
        }
        rows = self.conn.execute(
            "SELECT wave_no, COUNT(*) AS lines, COUNT(DISTINCT group_no) AS groups, "
            "COALESCE(SUM(amount),0) AS amount, MIN(wave_time) AS wave_time, "
            "MIN(order_date) AS order_date, MAX(status) AS status "
            "FROM ship_lines WHERE wave_no IS NOT NULL GROUP BY wave_no ORDER BY wave_no DESC"
        ).fetchall()
        result = []
        for r in rows:
            if r["wave_no"] in registered:
                continue
            result.append(
                {
                    "wave_no": r["wave_no"],
                    "lines": r["lines"],
                    "groups": r["groups"],
                    "amount": round((r["amount"] or 0) / 10000.0, 2) if self.with_amount() else None,
                    "wave_time": r["wave_time"],
                    "order_date": r["order_date"],
                    "status": r["status"],
                }
            )
        self.json_out({"biz_date": date, "rows": result})

    def api_waves_create(self, _match, _query):
        self.require("action.waves.create")
        body = self.read_json()
        date = body.get("date") or db.today_str()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(date)):
            raise ApiError(400, "日期格式应为 YYYY-MM-DD")
        raw = body.get("waves") or []
        if isinstance(raw, str):
            raw = re.split(r"[\s,，;；]+", raw)
        waves = [str(w).strip() for w in raw if str(w).strip()]
        if not waves:
            raise ApiError(400, "请提供波次号")
        added, skipped, pending = [], [], []
        for wave in waves:
            if len(wave) > 40 or not re.match(r"^[A-Za-z0-9_.\-]+$", wave):
                skipped.append({"wave_no": wave, "reason": "波次号格式不正确"})
                continue
            existing = self.conn.execute(
                "SELECT id, deleted_at FROM wave_registry WHERE biz_date=? AND wave_no=?",
                (date, wave),
            ).fetchone()
            if existing and not existing["deleted_at"]:
                skipped.append({"wave_no": wave, "reason": "该波次已登记"})
                continue
            if existing:
                self.conn.execute(
                    "UPDATE wave_registry SET deleted_at=NULL, updated_by=?, updated_at=? WHERE id=?",
                    (self.user["id"], db.now_str(), existing["id"]),
                )
            else:
                self.conn.execute(
                    "INSERT INTO wave_registry(biz_date, wave_no, created_by, created_at, updated_by, updated_at) "
                    "VALUES(?,?,?,?,?,?)",
                    (date, wave, self.user["id"], db.now_str(), self.user["id"], db.now_str()),
                )
            added.append(wave)
            if not rules.wave_has_data(self.conn, wave):
                pending.append(wave)
        self.conn.execute("INSERT OR IGNORE INTO meta(key, value) VALUES('data_version','1')")
        db.bump_version(self.conn)
        rules.rebuild_snapshots(self.conn)
        archived = archive.auto_archive(self.conn, self.user)
        db.audit(
            self.conn, self.user, self.client_ip(), "waves.create", date,
            json.dumps({"added": added, "skipped": skipped, "pending": pending}, ensure_ascii=False),
        )
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True, "added": added, "skipped": skipped, "pending": pending, "archived": archived})

    def api_waves_update(self, match, _query):
        self.require("action.waves.update")
        wave_id = int(match.group(1))
        row = self.conn.execute("SELECT * FROM wave_registry WHERE id=?", (wave_id,)).fetchone()
        if not row:
            raise ApiError(404, "波次登记不存在")
        body = self.read_json()
        note = body.get("note", row["note"])
        carrier = body.get("carrier_override", row["carrier_override"])
        if body.get("expected_updated_at") and row["updated_at"] != body["expected_updated_at"]:
            raise ApiError(409, "该波次刚被别人修改，请刷新后再试")
        self.conn.execute(
            "UPDATE wave_registry SET note=?, carrier_override=?, updated_by=?, updated_at=? WHERE id=?",
            (note, carrier, self.user["id"], db.now_str(), wave_id),
        )
        db.bump_version(self.conn)
        rules.rebuild_snapshots(self.conn)
        db.audit(
            self.conn, self.user, self.client_ip(), "waves.update", row["wave_no"],
            json.dumps({"note": note, "carrier_override": carrier}, ensure_ascii=False),
        )
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True})

    def api_waves_delete(self, match, _query):
        self.require("action.waves.delete")
        wave_id = int(match.group(1))
        row = self.conn.execute("SELECT * FROM wave_registry WHERE id=?", (wave_id,)).fetchone()
        if not row:
            raise ApiError(404, "波次登记不存在")
        self.conn.execute(
            "UPDATE wave_registry SET deleted_at=?, updated_by=?, updated_at=? WHERE id=?",
            (db.now_str(), self.user["id"], db.now_str(), wave_id),
        )
        db.bump_version(self.conn)
        rules.rebuild_snapshots(self.conn)
        db.audit(self.conn, self.user, self.client_ip(), "waves.delete", row["wave_no"], row["biz_date"])
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True})

    def api_wave_orders(self, match, _query):
        self.require("page.waves", "page.progress")
        wave_id = int(match.group(1))
        row = self.conn.execute("SELECT * FROM wave_registry WHERE id=?", (wave_id,)).fetchone()
        if not row:
            raise ApiError(404, "波次登记不存在")
        data = rules.order_groups(
            self.conn, row["biz_date"], self.user["id"], self.with_amount(),
            mode="live", wave=row["wave_no"], included="all", sort="reg", page=1, size=1000,
        )
        self.json_out(
            {
                "wave_no": row["wave_no"],
                "pending": not rules.wave_has_data(self.conn, row["wave_no"]),
                "total": data["total"],
                "summary": data["summary"],
                "rows": data["rows"],
            }
        )

    # ================================================================ 订单组台账
    def api_order_groups(self, _match, query):
        self.require("page.orders")
        date = self.biz_date(query)
        mode = (query.get("mode") or ["live"])[0]
        data = rules.order_groups(
            self.conn, date, self.user["id"], self.with_amount(),
            mode="archive" if mode == "archive" else "live",
            wave=(query.get("wave") or [""])[0],
            route=(query.get("route") or [""])[0],
            region=(query.get("region") or [""])[0],
            q=(query.get("q") or [""])[0],
            included=(query.get("included") or ["all"])[0],
            sort=(query.get("sort") or ["reg"])[0],
            page=(query.get("page") or ["1"])[0],
            size=(query.get("size") or ["100"])[0],
        )
        self.json_out(data)

    def api_order_group_save(self, match, query):
        self.require("action.orders.override")
        group_no = urllib.parse.unquote(match.group(1))
        date = self.biz_date(query)
        body = self.read_json()
        existing = self.conn.execute(
            "SELECT * FROM order_overrides WHERE biz_date=? AND group_no=?", (date, group_no)
        ).fetchone()
        if body.get("expected_updated_at") and existing and existing["updated_at"] != body["expected_updated_at"]:
            raise ApiError(409, "该订单组刚被别人修改，请刷新后再试")

        def pick(key, column):
            if key in body:
                value = body.get(key)
                return (str(value).strip() or None) if value is not None else None
            return existing[column] if existing else None

        route = pick("route_override", "route_override")
        region = pick("region_override", "region_override")
        assignee = pick("assign_override", "assign_override")
        note = pick("note", "note")
        if "include" in body:
            include = 1 if body.get("include") else 0
        elif existing:
            include = int(existing["include_flag"])
        else:
            include = 1
        self.conn.execute(
            "INSERT INTO order_overrides(biz_date, group_no, route_override, region_override, "
            "assign_override, note, include_flag, updated_by, updated_at) VALUES(?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(biz_date, group_no) DO UPDATE SET route_override=excluded.route_override, "
            "region_override=excluded.region_override, assign_override=excluded.assign_override, "
            "note=excluded.note, include_flag=excluded.include_flag, updated_by=excluded.updated_by, "
            "updated_at=excluded.updated_at",
            (date, group_no, route, region, assignee, note, include, self.user["id"], db.now_str()),
        )
        db.bump_version(self.conn)
        rules.rebuild_snapshots(self.conn)
        db.audit(
            self.conn, self.user, self.client_ip(), "order.override", "%s/%s" % (date, group_no),
            json.dumps(
                {"route": route, "region": region, "assignee": assignee, "note": note, "include": include},
                ensure_ascii=False,
            ),
        )
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True})

    # ================================================================ 动力电池登记
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

    def api_export_battery_archive(self, _match, query):
        self.require("action.export")
        body = battery_archive.export_csv(
            self.conn,
            date_from=(query.get("from") or [""])[0].strip(),
            date_to=(query.get("to") or [""])[0].strip(),
            q=(query.get("q") or [""])[0].strip(),
            status=(query.get("status") or [""])[0].strip(),
        )
        filename = "动力电池存档.csv"
        self._send(200, body, "text/csv; charset=utf-8",
                   {"Content-Disposition": "attachment; filename*=UTF-8''%s" % urllib.parse.quote(filename)})

    def api_export_battery(self, _match, query):
        self.require("action.export")
        body = battery.export_csv(
            self.conn,
            date_from=(query.get("from") or [""])[0].strip(),
            date_to=(query.get("to") or [""])[0].strip(),
            q=(query.get("q") or [""])[0].strip(),
            status=(query.get("status") or [""])[0].strip(),
            with_amount=self.with_amount(),
        )
        filename = "动力电池登记.csv"
        self._send(200, body, "text/csv; charset=utf-8",
                   {"Content-Disposition": "attachment; filename*=UTF-8''%s" % urllib.parse.quote(filename)})

    def api_order_group_reset(self, match, query):
        self.require("action.orders.override")
        group_no = urllib.parse.unquote(match.group(1))
        date = self.biz_date(query)
        self.conn.execute(
            "DELETE FROM order_overrides WHERE biz_date=? AND group_no=?", (date, group_no)
        )
        db.bump_version(self.conn)
        rules.rebuild_snapshots(self.conn)
        db.audit(self.conn, self.user, self.client_ip(), "order.reset", "%s/%s" % (date, group_no), "")
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True})

    # ================================================================ 每日存档
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

    # ================================================================ 经销商
    def api_dealers(self, _match, query):
        self.require("page.sources", "action.dealers.manage")
        q = (query.get("q") or [""])[0].strip()
        page = max(1, int((query.get("page") or ["1"])[0] or 1))
        size = min(200, max(10, int((query.get("size") or ["50"])[0] or 50)))
        where, params = "", []
        if q:
            where = "WHERE full_name LIKE ? OR short_name LIKE ? OR region LIKE ? OR route LIKE ?"
            like = "%" + q + "%"
            params = [like] * 4
        total = self.conn.execute("SELECT COUNT(*) AS c FROM dealer_map " + where, params).fetchone()["c"]
        rows = self.conn.execute(
            "SELECT * FROM dealer_map " + where + " ORDER BY full_name LIMIT ? OFFSET ?",
            params + [size, (page - 1) * size],
        ).fetchall()
        self.json_out(
            {
                "total": total,
                "page": page,
                "size": size,
                "rows": [dict(r) for r in rows],
            }
        )

    def api_dealer_save(self, _match, _query):
        self.require("action.dealers.manage")
        body = self.read_json()
        full = (body.get("full_name") or "").strip()
        if not full:
            raise ApiError(400, "缺少经销商全称")
        self.conn.execute(
            "INSERT INTO dealer_map(full_name, short_name, region, route, updated_at) VALUES(?,?,?,?,?) "
            "ON CONFLICT(full_name) DO UPDATE SET short_name=excluded.short_name, region=excluded.region, "
            "route=excluded.route, updated_at=excluded.updated_at",
            (
                full,
                (body.get("short_name") or full).strip(),
                (body.get("region") or "").strip() or None,
                (body.get("route") or "").strip() or None,
                db.now_str(),
            ),
        )
        db.bump_version(self.conn)
        db.audit(self.conn, self.user, self.client_ip(), "dealer.save", full, json.dumps(body, ensure_ascii=False))
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True})

    def api_dealers_import(self, _match, _query):
        self.require("action.dealers.manage")
        raw = self.read_body()
        if not raw:
            raise ApiError(400, "没有内容")
        if raw[:4] == b"PK\x03\x04":
            tmp = tempfile.NamedTemporaryFile(prefix="dealers_", suffix=".xlsx", delete=False)
            try:
                tmp.write(raw)
                tmp.close()
                result = ingest.import_dealer_workbook(self.conn, tmp.name)
            except Exception as exc:  # noqa: BLE001
                raise ApiError(400, "Excel 导入失败：%s" % exc)
            finally:
                try:
                    os.remove(tmp.name)
                except OSError:
                    pass
            db.audit(self.conn, self.user, self.client_ip(), "dealers.import", "",
                     "普通 %d / 动力电池 %d" % (result["base"], result["battery"]))
            HUB.broadcast(db.get_version(self.conn))
            self.json_out({
                "ok": True, "count": result["total"], "created": result["base"],
                "updated": result["battery"], "battery": result["battery"],
                "base": result["base"], "skipped": 0, "samples": [],
            })
            return
        text = raw.decode("utf-8-sig", errors="replace")
        reader = csv.reader(io.StringIO(text))
        rows = list(reader)
        if not rows:
            raise ApiError(400, "CSV 为空")
        header = [c.strip() for c in rows[0]]
        idx = {}
        for i, name in enumerate(header):
            if name in ("全称", "经销商全称"):
                idx["full"] = i
            elif name in ("简称", "经销商简称"):
                idx["short"] = i
            elif name == "区域":
                idx["region"] = i
            elif name in ("承运商", "线路", "承运商/线路", "承运商／线路", "承运商/路线"):
                idx["route"] = i
        if "full" not in idx:
            raise ApiError(400, "CSV 需要包含「全称」列")
        created = updated = skipped = 0
        skipped_names = []

        def pick(row, key):
            return row[idx[key]].strip() if key in idx and idx[key] < len(row) else ""

        for row in rows[1:]:
            if not row:
                skipped += 1
                continue
            full = pick(row, "full")
            if not full:
                skipped += 1
                if len(skipped_names) < 10:
                    skipped_names.append(row[:1])
                continue
            existing = self.conn.execute(
                "SELECT * FROM dealer_map WHERE full_name=?", (full,)
            ).fetchone()
            short, region, route = pick(row, "short"), pick(row, "region"), pick(row, "route")
            if existing:
                # 只覆盖非空字段，空值保持原值（避免批量导入把已有映射清空）
                new_short = short or existing["short_name"] or full
                new_region = region or existing["region"]
                new_route = route or existing["route"]
                if (new_short, new_region, new_route) != (
                    existing["short_name"], existing["region"], existing["route"]
                ):
                    self.conn.execute(
                        "UPDATE dealer_map SET short_name=?, region=?, route=?, updated_at=? WHERE full_name=?",
                        (new_short, new_region, new_route, db.now_str(), full),
                    )
                    updated += 1
                else:
                    skipped += 1
            else:
                self.conn.execute(
                    "INSERT INTO dealer_map(full_name, short_name, region, route, updated_at) "
                    "VALUES(?,?,?,?,?)",
                    (full, short or full, region or None, route or None, db.now_str()),
                )
                created += 1
        count = created + updated
        db.bump_version(self.conn)
        db.audit(
            self.conn, self.user, self.client_ip(), "dealers.import", "",
            "新增 %d / 更新 %d / 跳过 %d" % (created, updated, skipped),
        )
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({
            "ok": True, "count": count, "created": created, "updated": updated,
            "skipped": skipped, "samples": skipped_names,
        })

    def api_dealers_unmapped(self, _match, _query):
        self.require("page.sources", "action.dealers.manage")
        rows = self._unmapped_dealers()
        self.json_out({"count": len(rows), "rows": rows[:300]})

    # ================================================================ 看板
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

    # ================================================================ 导航页看板
    def _page_row(self, key, user_id=None):
        if user_id is None:
            return self.conn.execute(
                "SELECT * FROM dashboards WHERE page_key=? AND owner_user_id IS NULL", (key,)
            ).fetchone()
        return self.conn.execute(
            "SELECT * FROM dashboards WHERE page_key=? AND owner_user_id=?", (key, user_id)
        ).fetchone()

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

    # ================================================================ 看板总台
    @staticmethod
    def _layout_of(row):
        try:
            return json.loads(row["layout_json"] or "{}")
        except (ValueError, TypeError):
            return {"widgets": []}

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

    # ================================================================ 预警 / 大屏 / 人效
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

    SCREEN_DEFAULT = {"items": ["overview", "progress", "labor", "volume", "trend"],
                      "interval": 15, "sound": True}

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

    # ================================================================ 人工作业量（按作业日期）
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

    # ================================================================ 组件取数
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

    # ================================================================ 用户 / 组 / 权限
    def api_users(self, _match, _query):
        self.require("action.users.manage")
        rows = self.conn.execute("SELECT * FROM users ORDER BY id").fetchall()
        groups = {}
        for r in self.conn.execute(
            "SELECT gm.user_id, g.id, g.name FROM group_members gm JOIN groups g ON g.id=gm.group_id"
        ):
            groups.setdefault(r["user_id"], []).append({"id": r["id"], "name": r["name"]})
        result = []
        for r in rows:
            result.append(
                {
                    "id": r["id"],
                    "username": r["username"],
                    "display_name": r["display_name"],
                    "status": r["status"],
                    "must_change_pwd": bool(r["must_change_pwd"]),
                    "last_login_at": r["last_login_at"],
                    "created_at": r["created_at"],
                    "groups": groups.get(r["id"], []),
                    "permissions": sorted(auth.effective_permissions(self.conn, r["id"])),
                }
            )
        self.json_out({"rows": result, "groups": self._groups_payload()})

    def _groups_payload(self):
        result = []
        for g in self.conn.execute("SELECT * FROM groups ORDER BY id"):
            members = [
                r["user_id"]
                for r in self.conn.execute("SELECT user_id FROM group_members WHERE group_id=?", (g["id"],))
            ]
            allow = [
                r["perm_code"]
                for r in self.conn.execute(
                    "SELECT perm_code FROM group_permissions WHERE group_id=? AND effect='allow'", (g["id"],)
                )
            ]
            deny = [
                r["perm_code"]
                for r in self.conn.execute(
                    "SELECT perm_code FROM group_permissions WHERE group_id=? AND effect='deny'", (g["id"],)
                )
            ]
            scopes = {}
            for r in self.conn.execute(
                "SELECT dim, values_json FROM data_scopes WHERE owner_type='group' AND owner_id=?",
                (g["id"],),
            ):
                try:
                    scopes[r["dim"]] = json.loads(r["values_json"])
                except Exception:
                    pass
            result.append(
                {
                    "id": g["id"],
                    "name": g["name"],
                    "description": g["description"],
                    "members": members,
                    "allow": allow,
                    "deny": deny,
                    "scopes": scopes,
                }
            )
        return result

    def api_user_create(self, _match, _query):
        self.require("action.users.manage")
        body = self.read_json()
        username = (body.get("username") or "").strip()
        if not re.match(r"^[A-Za-z0-9_.-]{3,32}$", username):
            raise ApiError(400, "用户名 3-32 位，仅字母数字下划线")
        if auth.get_user_by_username(self.conn, username):
            raise ApiError(400, "用户名已存在")
        password = body.get("password") or ""
        problem = auth.password_problem(password)
        if problem:
            raise ApiError(400, problem)
        role = body.get("role") or "viewer"
        uid = auth.create_user(
            self.conn, username, (body.get("display_name") or username).strip(),
            password, role=role, must_change=1,
        )
        for gid in body.get("groups") or []:
            self.conn.execute(
                "INSERT OR IGNORE INTO group_members(group_id, user_id) VALUES(?,?)", (int(gid), uid)
            )
        db.audit(self.conn, self.user, self.client_ip(), "user.create", username, "role=" + role)
        self.json_out({"ok": True, "id": uid})

    def api_user_update(self, match, _query):
        self.require("action.users.manage")
        uid = int(match.group(1))
        user = auth.get_user(self.conn, uid)
        if not user:
            raise ApiError(404, "用户不存在")
        body = self.read_json()
        if body.get("display_name") is not None:
            self.conn.execute(
                "UPDATE users SET display_name=? WHERE id=?",
                ((body["display_name"] or "").strip() or user["username"], uid),
            )
        if body.get("status") in ("active", "disabled"):
            if uid == self.user["id"] and body["status"] == "disabled":
                raise ApiError(400, "不能停用自己")
            self.conn.execute("UPDATE users SET status=? WHERE id=?", (body["status"], uid))
        if body.get("groups") is not None:
            self.conn.execute("DELETE FROM group_members WHERE user_id=?", (uid,))
            for gid in body["groups"]:
                self.conn.execute(
                    "INSERT OR IGNORE INTO group_members(group_id, user_id) VALUES(?,?)", (int(gid), uid)
                )
        if body.get("allow") is not None or body.get("deny") is not None:
            self.conn.execute("DELETE FROM user_permissions WHERE user_id=?", (uid,))
            for code in body.get("allow") or []:
                if code in perms.PERM_CODES:
                    self.conn.execute(
                        "INSERT INTO user_permissions(user_id, perm_code, effect) VALUES(?,?,'allow')",
                        (uid, code),
                    )
            for code in body.get("deny") or []:
                if code in perms.PERM_CODES:
                    self.conn.execute(
                        "INSERT INTO user_permissions(user_id, perm_code, effect) VALUES(?,?,'deny')",
                        (uid, code),
                    )
        db.bump_version(self.conn)
        db.audit(self.conn, self.user, self.client_ip(), "user.update", user["username"],
                 json.dumps(body, ensure_ascii=False))
        self.json_out({"ok": True})

    def api_user_reset(self, match, _query):
        self.require("action.users.resetpwd")
        uid = int(match.group(1))
        user = auth.get_user(self.conn, uid)
        if not user:
            raise ApiError(404, "用户不存在")
        body = self.read_json()
        password = body.get("password") or ""
        problem = auth.password_problem(password)
        if problem:
            raise ApiError(400, problem)
        auth.set_password(self.conn, uid, password, must_change=1)
        db.audit(self.conn, self.user, self.client_ip(), "user.resetpwd", user["username"], "")
        self.json_out({"ok": True, "temp_password": password})

    def api_groups(self, _match, _query):
        self.require("action.users.manage")
        self.json_out({"rows": self._groups_payload()})

    def api_group_create(self, _match, _query):
        self.require("action.users.manage")
        body = self.read_json()
        name = (body.get("name") or "").strip()
        if not name:
            raise ApiError(400, "组名不能为空")
        try:
            cur = self.conn.execute(
                "INSERT INTO groups(name, description) VALUES(?,?)",
                (name, (body.get("description") or "").strip() or None),
            )
        except Exception:
            raise ApiError(400, "组名已存在")
        db.audit(self.conn, self.user, self.client_ip(), "group.create", name, "")
        self.json_out({"ok": True, "id": cur.lastrowid})

    def api_group_update(self, match, _query):
        self.require("action.users.manage")
        gid = int(match.group(1))
        row = self.conn.execute("SELECT * FROM groups WHERE id=?", (gid,)).fetchone()
        if not row:
            raise ApiError(404, "组不存在")
        body = self.read_json()
        if body.get("name") is not None:
            self.conn.execute(
                "UPDATE groups SET name=?, description=? WHERE id=?",
                ((body["name"] or row["name"]).strip(), (body.get("description") or row["description"]), gid),
            )
        if body.get("members") is not None:
            self.conn.execute("DELETE FROM group_members WHERE group_id=?", (gid,))
            for uid in body["members"]:
                self.conn.execute(
                    "INSERT OR IGNORE INTO group_members(group_id, user_id) VALUES(?,?)", (gid, int(uid))
                )
        if body.get("allow") is not None or body.get("deny") is not None:
            self.conn.execute("DELETE FROM group_permissions WHERE group_id=?", (gid,))
            for code in body.get("allow") or []:
                if code in perms.PERM_CODES:
                    self.conn.execute(
                        "INSERT INTO group_permissions(group_id, perm_code, effect) VALUES(?,?,'allow')",
                        (gid, code),
                    )
            for code in body.get("deny") or []:
                if code in perms.PERM_CODES:
                    self.conn.execute(
                        "INSERT INTO group_permissions(group_id, perm_code, effect) VALUES(?,?,'deny')",
                        (gid, code),
                    )
        db.bump_version(self.conn)
        db.audit(self.conn, self.user, self.client_ip(), "group.update", row["name"], json.dumps(body, ensure_ascii=False))
        self.json_out({"ok": True})

    def api_group_delete(self, match, _query):
        self.require("action.users.manage")
        gid = int(match.group(1))
        row = self.conn.execute("SELECT * FROM groups WHERE id=?", (gid,)).fetchone()
        if not row:
            raise ApiError(404, "组不存在")
        self.conn.execute("DELETE FROM group_members WHERE group_id=?", (gid,))
        self.conn.execute("DELETE FROM group_permissions WHERE group_id=?", (gid,))
        self.conn.execute("DELETE FROM data_scopes WHERE owner_type='group' AND owner_id=?", (gid,))
        self.conn.execute("DELETE FROM groups WHERE id=?", (gid,))
        db.audit(self.conn, self.user, self.client_ip(), "group.delete", row["name"], "")
        self.json_out({"ok": True})

    def api_permissions(self, _match, _query):
        self.require("action.users.manage")
        self.json_out(
            {
                "permissions": [
                    {"code": code, "group": group, "title": title, "description": description}
                    for code, group, title, description in perms.PERMISSIONS
                ],
                "presets": {role: sorted(codes) for role, codes in perms.PRESETS.items()},
                "roles": perms.ROLE_TITLES,
                "scope_dims": perms.SCOPE_DIMS,
                "groups": self._groups_payload(),
                "users": [
                    {
                        "id": r["id"],
                        "display_name": r["display_name"],
                        "username": r["username"],
                        "allow": [
                            x["perm_code"]
                            for x in self.conn.execute(
                                "SELECT perm_code FROM user_permissions WHERE user_id=? AND effect='allow'",
                                (r["id"],),
                            )
                        ],
                        "deny": [
                            x["perm_code"]
                            for x in self.conn.execute(
                                "SELECT perm_code FROM user_permissions WHERE user_id=? AND effect='deny'",
                                (r["id"],),
                            )
                        ],
                        "scopes": auth.scope_summary(self.conn, r["id"]),
                    }
                    for r in self.conn.execute("SELECT * FROM users ORDER BY id")
                ],
            }
        )

    def api_permission_group(self, match, _query):
        self.require("action.users.manage")
        gid = int(match.group(1))
        body = self.read_json()
        self.conn.execute("DELETE FROM group_permissions WHERE group_id=?", (gid,))
        for code in body.get("allow") or []:
            if code in perms.PERM_CODES:
                self.conn.execute(
                    "INSERT INTO group_permissions(group_id, perm_code, effect) VALUES(?,?,'allow')", (gid, code)
                )
        for code in body.get("deny") or []:
            if code in perms.PERM_CODES:
                self.conn.execute(
                    "INSERT INTO group_permissions(group_id, perm_code, effect) VALUES(?,?,'deny')", (gid, code)
                )
        db.audit(self.conn, self.user, self.client_ip(), "perm.group", str(gid), json.dumps(body, ensure_ascii=False))
        self.json_out({"ok": True})

    def api_permission_user(self, match, _query):
        self.require("action.users.manage")
        uid = int(match.group(1))
        body = self.read_json()
        self.conn.execute("DELETE FROM user_permissions WHERE user_id=?", (uid,))
        for code in body.get("allow") or []:
            if code in perms.PERM_CODES:
                self.conn.execute(
                    "INSERT INTO user_permissions(user_id, perm_code, effect) VALUES(?,?,'allow')", (uid, code)
                )
        for code in body.get("deny") or []:
            if code in perms.PERM_CODES:
                self.conn.execute(
                    "INSERT INTO user_permissions(user_id, perm_code, effect) VALUES(?,?,'deny')", (uid, code)
                )
        db.audit(self.conn, self.user, self.client_ip(), "perm.user", str(uid), json.dumps(body, ensure_ascii=False))
        self.json_out({"ok": True})

    def api_scope_save(self, match, _query):
        self.require("action.users.manage")
        owner_type = match.group(1)
        owner_id = int(match.group(2))
        body = self.read_json()
        scopes = body.get("scopes") or {}
        self.conn.execute(
            "DELETE FROM data_scopes WHERE owner_type=? AND owner_id=?", (owner_type, owner_id)
        )
        for dim, values in scopes.items():
            if dim not in perms.SCOPE_DIMS:
                continue
            values = [str(v) for v in (values or []) if str(v).strip()]
            if not values:
                continue
            self.conn.execute(
                "INSERT INTO data_scopes(owner_type, owner_id, dim, values_json) VALUES(?,?,?,?)",
                (owner_type, owner_id, dim, json.dumps(values, ensure_ascii=False)),
            )
        db.audit(self.conn, self.user, self.client_ip(), "scope.save", "%s:%s" % (owner_type, owner_id),
                 json.dumps(scopes, ensure_ascii=False))
        self.json_out({"ok": True})

    def api_audit(self, _match, query):
        self.require("action.audit.view")
        page = max(1, int((query.get("page") or ["1"])[0] or 1))
        size = 50
        total = self.conn.execute("SELECT COUNT(*) AS c FROM audit_log").fetchone()["c"]
        rows = self.conn.execute(
            "SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?", (size, (page - 1) * size)
        ).fetchall()
        self.json_out(
            {
                "total": total,
                "page": page,
                "size": size,
                "rows": [
                    {
                        "id": r["id"],
                        "ts": r["ts"],
                        "username": r["username"],
                        "ip": r["ip"],
                        "action": r["action"],
                        "target": r["target"],
                        "detail": r["detail"],
                    }
                    for r in rows
                ],
            }
        )

    # ================================================================ 导出
    def api_export_summary(self, _match, query):
        """导出与现行「单量表」同版式的 CSV：线路 × 库区（行数/金额）。"""
        self.require("action.export")
        date = self.biz_date(query)
        data = rules.summary_matrix(self.conn, date, self.user["id"], self.with_amount())
        header = ["承运商/线路"]
        for zone in data["zones"]:
            header.append(zone + " 行数")
            if data["with_amount"]:
                header.append(zone + " 金额(万)")
        header.extend(["合计行数", "订单组数"])
        if data["with_amount"]:
            header.append("合计金额(万)")

        rows = [["业务日期", date], header]
        for item in data["routes"]:
            row = [item["label"]]
            for zone in data["zones"]:
                cell = item["cells"].get(zone)
                row.append(cell["lines"] if cell else 0)
                if data["with_amount"]:
                    row.append(cell["amount"] if cell else 0)
            row.extend([item["lines"], item["groups"]])
            if data["with_amount"]:
                row.append(item["amount"])
            rows.append(row)

        row = ["合计"]
        for zone in data["zones"]:
            row.append(data["zone_totals"][zone]["lines"])
            if data["with_amount"]:
                row.append(data["zone_totals"][zone]["amount"])
        row.extend([data["totals"]["lines"], data["totals"]["groups"]])
        if data["with_amount"]:
            row.append(data["totals"]["amount"])
        rows.append(row)

        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerows(rows)
        body = ("\ufeff" + buffer.getvalue()).encode("utf-8")
        filename = "单量表_%s.csv" % date
        self._send(
            200,
            body,
            "text/csv; charset=utf-8",
            {"Content-Disposition": "attachment; filename*=UTF-8''%s" % urllib.parse.quote(filename)},
        )

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

    def api_export_archive(self, _match, query):
        """导出归档：type=orders|labor，from/to 为业务日期区间（可同一天）。"""
        self.require("action.export")
        kind = (query.get("type") or ["orders"])[0]
        date_from = (query.get("from") or query.get("date") or [""])[0].strip()
        date_to = (query.get("to") or query.get("date") or [""])[0].strip()
        pattern = r"^\d{4}-\d{2}-\d{2}$"
        if not re.match(pattern, date_from) or not re.match(pattern, date_to):
            raise ApiError(400, "日期格式不正确")
        if date_to < date_from:
            date_from, date_to = date_to, date_from
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        if kind == "labor":
            header = ["作业日期", "人员", "工种", "行数", "订单组数", "自动小时", "采用小时", "人效", "归档时间"]
            rows = self.conn.execute(
                "SELECT * FROM labor_archive WHERE biz_date BETWEEN ? AND ? "
                "ORDER BY biz_date, role, rows DESC",
                (date_from, date_to),
            ).fetchall()
            writer.writerow(header)
            for r in rows:
                writer.writerow(
                    [
                        r["biz_date"], r["person"],
                        "拣货" if r["role"] == "pick" else ("复核" if r["role"] == "check" else r["role"]),
                        r["rows"], r["groups"], r["hours_auto"], r["hours_used"], r["rate"],
                        r["archived_at"],
                    ]
                )
            filename = "人效归档_%s_%s.csv" % (date_from, date_to)
        else:
            header = [
                "业务日期", "序号", "订单组号", "经销商", "行数", "金额", "库区", "单据类型",
                "是否免运费", "区域", "承运商", "波次号", "清洗", "指派", "备注", "是否计入", "归档时间",
            ]
            rows = self.conn.execute(
                "SELECT * FROM daily_archive WHERE biz_date BETWEEN ? AND ? ORDER BY biz_date, seq",
                (date_from, date_to),
            ).fetchall()
            writer.writerow(header)
            for r in rows:
                writer.writerow(
                    [
                        r["biz_date"], r["seq"], r["group_no"], r["dealer_short"], r["lines"],
                        r["amount"] if self.with_amount() else "",
                        r["zone"], r["doc_type"], r["freight_free"], r["region"], r["route"],
                        r["wave_no"], r["tms_status"], r["assignee"], r["note"],
                        "计入" if r["included"] else "已移出", r["archived_at"],
                    ]
                )
            filename = "订单组归档_%s_%s.csv" % (date_from, date_to)
        body = ("\ufeff" + buffer.getvalue()).encode("utf-8")
        db.audit(self.conn, self.user, self.client_ip(), "archive.export", kind,
                 "%s~%s" % (date_from, date_to))
        self._send(
            200,
            body,
            "text/csv; charset=utf-8",
            {"Content-Disposition": "attachment; filename*=UTF-8''%s" % urllib.parse.quote(filename)},
        )

    def api_export_unmapped_dealers(self, _match, _query):
        """导出未映射经销商清单（可直接填好再批量导入）。"""
        self.require("action.dealers.manage")
        rows = self._unmapped_dealers()
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["全称", "简称", "区域", "承运商/线路", "行数", "金额(元)"])
        for item in rows:
            amount = "" if item.get("amount") is None else "%.2f" % (item["amount"] * 10000.0)
            writer.writerow([item["full_name"], "", "", "", item["lines"], amount])
        body = ("\ufeff" + buffer.getvalue()).encode("utf-8")
        db.audit(self.conn, self.user, self.client_ip(), "dealers.unmapped.export", "", "%d 条" % len(rows))
        filename = "未映射经销商_%s.csv" % db.today_str()
        self._send(
            200, body, "text/csv; charset=utf-8",
            {"Content-Disposition": "attachment; filename*=UTF-8''%s" % urllib.parse.quote(filename)},
        )

    def api_export_order_groups(self, _match, query):
        """导出订单组台账（13 列，与页面一致；支持实时/存档两种模式）。"""
        self.require("action.export")
        date = self.biz_date(query)
        mode = "archive" if (query.get("mode") or ["live"])[0] == "archive" else "live"
        collected = []
        page = 1
        while True:
            data = rules.order_groups(
                self.conn, date, self.user["id"], self.with_amount(),
                mode=mode, included=(query.get("included") or ["all"])[0],
                wave=(query.get("wave") or [""])[0],
                sort=(query.get("sort") or ["reg"])[0],
                page=page, size=1000,
            )
            collected.extend(data["rows"])
            if len(collected) >= (data.get("total") or 0) or not data["rows"]:
                break
            page += 1

        header = [
            "序号", "订单组号", "经销商", "行数", "金额", "库区", "单据类型",
            "是否免运费", "区域", "承运商", "波次号", "清洗", "指派", "备注", "是否计入",
        ]
        rows = [["业务日期", date, "数据来源", "存档快照" if mode == "archive" else "实时"], header]
        for item in collected:
            rows.append(
                [
                    item.get("seq"), item.get("group_no"), item.get("dealer"), item.get("lines"),
                    item.get("amount") if self.with_amount() else "",
                    item.get("zone"), item.get("doc_type"), item.get("freight_free"),
                    item.get("region"), item.get("route"), item.get("wave_no"),
                    item.get("tms_status"), item.get("assignee"), item.get("note"),
                    "计入" if item.get("included", 1) else "已移出",
                ]
            )
        buffer = io.StringIO()
        csv.writer(buffer).writerows(rows)
        body = ("\ufeff" + buffer.getvalue()).encode("utf-8")
        filename = "订单组台账_%s.csv" % date
        self._send(
            200,
            body,
            "text/csv; charset=utf-8",
            {"Content-Disposition": "attachment; filename*=UTF-8''%s" % urllib.parse.quote(filename)},
        )

    # ================================================================ SSE
    def handle_sse(self, _query):
        if not self.user:
            raise ApiError(401, "未登录")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        channel = HUB.register()
        try:
            version = db.get_version(self.conn)
            self.wfile.write(("event: ready\ndata: %s\n\n" % json.dumps({"version": version})).encode("utf-8"))
            self.wfile.flush()
            while True:
                try:
                    version = channel.get(timeout=20)
                    payload = "event: update\ndata: %s\n\n" % json.dumps({"version": version})
                except queue.Empty:
                    payload = ": ping\n\n"
                self.wfile.write(payload.encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            HUB.unregister(channel)


# ---------------------------------------------------------------- 后台扫描
def maybe_backup(conn):
    """每天把 SQLite 备份一份到 data/backup，保留 backup_keep_days 天。

    - 先写临时文件并做 PRAGMA integrity_check，校验通过才原子替换成正式备份；
    - 每周日额外复制一份到 data/offsite，保留 28 天。
    """
    today = db.today_str()
    if db.get_meta(conn, "last_backup_date") == today:
        return
    try:
        import sqlite3

        os.makedirs(db.BACKUP_DIR, exist_ok=True)
        target = os.path.join(db.BACKUP_DIR, "dashboard_%s.db" % today.replace("-", ""))
        tmp = target + ".tmp"
        if os.path.exists(tmp):
            os.remove(tmp)
        dest = sqlite3.connect(tmp)
        try:
            conn.backup(dest)
            verdict = dest.execute("PRAGMA integrity_check").fetchone()[0]
        finally:
            dest.close()
        if verdict != "ok":
            try:
                os.remove(tmp)
            except OSError:
                pass
            log_line("备份校验失败（%s），已丢弃本次备份，保留上一份：%s" % (verdict, target))
            return
        os.replace(tmp, target)
        keep = int(CONFIG.get("backup_keep_days", 30) or 30)
        cutoff = time.time() - keep * 86400
        for name in os.listdir(db.BACKUP_DIR):
            path = os.path.join(db.BACKUP_DIR, name)
            try:
                if os.path.getmtime(path) < cutoff:
                    os.remove(path)
            except OSError:
                pass
        if time.localtime().tm_wday == 6:
            offsite = os.path.join(BASE_DIR, "data", "offsite")
            os.makedirs(offsite, exist_ok=True)
            shutil.copy2(target, os.path.join(offsite, os.path.basename(target)))
            off_cutoff = time.time() - 28 * 86400
            for name in os.listdir(offsite):
                path = os.path.join(offsite, name)
                try:
                    if os.path.getmtime(path) < off_cutoff:
                        os.remove(path)
                except OSError:
                    pass
            log_line("已生成每周异地副本：%s" % os.path.join(offsite, os.path.basename(target)))
        db.set_meta(conn, "last_backup_date", today)
        log_line("数据库已备份：%s" % target)
    except Exception:  # noqa: BLE001
        log_line("备份失败\n%s" % traceback.format_exc())


def scanner_loop():
    conn = db.connect()
    try:
        source_archive.migrate_storage(conn)
        source_archive.cleanup(conn)
    except Exception:  # noqa: BLE001
        log_line("归档初始化失败\n%s" % traceback.format_exc())
    while True:
        try:
            before = db.get_version(conn)
            report = ingest.scan(conn, CONFIG, wait=False)
            if not report.get("busy"):
                db.set_meta(conn, "last_scan_at", db.now_str())
                db.set_meta(conn, "last_scan_error", "；".join(report.get("errors") or []) or "")
                try:
                    refreshed = archive_refresh.refresh(conn, report)
                    if refreshed.get("orders") or refreshed.get("labor") or refreshed.get("battery_filled"):
                        log_line(
                            "自动归档：订单组 %s；人效 %s；电池 %s（新增 %d 行 / 变更 %d 行）"
                            % (
                                ",".join(refreshed.get("orders") or []) or "-",
                                ",".join(refreshed.get("labor") or []) or "-",
                                ",".join(refreshed.get("battery_filled") or []) or "-",
                                refreshed.get("added_rows") or 0,
                                refreshed.get("changed_rows") or 0,
                            )
                        )
                except Exception:  # noqa: BLE001
                    log_line("自动归档失败\n%s" % traceback.format_exc())
                try:
                    source_archive.cleanup(conn)
                except Exception:  # noqa: BLE001
                    log_line("归档清理失败\n%s" % traceback.format_exc())
            try:
                created = alerts.generate(conn)
                if created:
                    log_line("生成预警通知 %d 条" % created)
            except Exception:  # noqa: BLE001
                log_line("预警生成失败\n%s" % traceback.format_exc())
            after = db.get_version(conn)
            if after != before:
                HUB.broadcast(after)
            auth.cleanup_sessions(conn)
            maybe_backup(conn)
        except Exception:  # noqa: BLE001
            log_line("扫描失败\n%s" % traceback.format_exc())
            try:
                db.set_meta(conn, "last_scan_error", "%s %s" % (db.now_str(), "后台扫描异常，见日志"))
            except Exception:
                pass
        time.sleep(max(15, int(CONFIG.get("scan_sec", 60))))


def flag_default_passwords(conn):
    """一次性把仍在使用交付默认口令的账号标记为必须改密。"""
    if db.get_meta(conn, "default_pwd_flag_v1") == "1":
        return 0
    flagged = 0
    for row in conn.execute("SELECT id, pwd_hash, salt FROM users").fetchall():
        if auth.verify_password("Admin12345", row["pwd_hash"], row["salt"]):
            conn.execute("UPDATE users SET pwd_is_default=1 WHERE id=?", (row["id"],))
            flagged += 1
    db.set_meta(conn, "default_pwd_flag_v1", "1")
    if flagged:
        log_line("检测到 %d 个账号仍在使用默认口令，已要求登录后改密" % flagged)
    return flagged


def main(argv):
    global CONFIG
    port = CONFIG.get("port", 8787)
    bind = CONFIG.get("bind", "0.0.0.0")
    if "--port" in argv:
        port = int(argv[argv.index("--port") + 1])
    if "--bind" in argv:
        bind = argv[argv.index("--bind") + 1]

    db.init_db()
    conn = db.connect()
    flag_default_passwords(conn)
    ensure_default_dashboards(conn)
    ensure_page_dashboards(conn)
    ensure_page_layouts_v6(conn)
    ensure_page_layouts_v7(conn)
    ensure_page_layouts_v8(conn)
    ensure_page_layouts_v9(conn)
    ensure_personal_erp_widgets(conn)
    ensure_personal_page_layouts(conn)
    try:
        ensure_erp_detail_filters(conn)
    except Exception:  # noqa: BLE001
        log_line("ERP 明细筛选修复失败\n%s" % traceback.format_exc())
    try:
        outbound_archive.seed_from_legacy(conn)
        outbound_archive.purge_legacy(conn)
        outbound_archive.backfill_history(conn)
    except Exception:  # noqa: BLE001
        log_line("出库归档迁移失败\n%s" % traceback.format_exc())
    try:
        auth.ensure_presets(conn)
    except Exception:  # noqa: BLE001
        log_line("权限预设补齐失败\n%s" % traceback.format_exc())
    db.set_meta(conn, "last_boot_at", db.now_str())

    thread = threading.Thread(target=scanner_loop, name="scanner", daemon=True)
    thread.start()

    server = ThreadingHTTPServer((bind, port), Handler)
    server.daemon_threads = True
    log_line("看板服务已启动 http://%s:%d  （数据源：%s）" % (bind, port, ", ".join(ingest.resolve_dirs(CONFIG)) or "无"))
    print("看板服务已启动： http://127.0.0.1:%d" % port)
    for d in ingest.resolve_dirs(CONFIG):
        print("  数据源： %s %s" % ("OK" if os.path.isdir(d) else "不可达", d))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
