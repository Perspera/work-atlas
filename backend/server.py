# -*- coding: utf-8 -*-
"""HTTP 服务：静态页 + REST API + SSE 实时推送 + 登录与权限网关。

启动：python server.py            （读取 config.json）
      python server.py --port 9000
"""
import hashlib
import json
import os
import queue
import re
import sys
import threading
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from backend.domain import alerts
from backend.core import auth
from backend.core import db
from backend.collect import ingest
from backend.domain import rules
from backend.archives import outbound_archive

from api.runtime import (
    WEB_DIR,
    CONFIG,
    COOKIE_NAME,
    STATIC_EXTS,
    MUTATING,
    HUB,
    ApiError,
    log_line,
)
from api.core_mixin import CoreMixin
from api.data_mixin import DataMixin
from api.battery_mixin import BatteryMixin
from api.labor_mixin import LaborMixin
from api.dashboard_mixin import DashboardMixin
from api.alerts_mixin import AlertsMixin
from api.admin_mixin import AdminMixin
from api.export_mixin import ExportMixin
from api.archive_mixin import ArchiveMixin
from api.wms_mixin import WmsMixin
from api.boards_init import (
    ensure_default_dashboards,
    ensure_page_dashboards,
    ensure_user_dashboards,
)
from api.routes import ROUTES
from api.startup import (
    ensure_erp_detail_filters,
    ensure_page_layouts_v6,
    ensure_page_layouts_v7,
    ensure_page_layouts_v8,
    ensure_page_layouts_v9,
    ensure_personal_erp_widgets,
    ensure_personal_page_layouts,
    flag_default_passwords,
    scanner_loop,
)


# ---------------------------------------------------------------- 模板与初始化


























# ---------------------------------------------------------------- Handler
class Handler(CoreMixin, DataMixin, BatteryMixin, LaborMixin, DashboardMixin, AlertsMixin, AdminMixin, ExportMixin, ArchiveMixin, WmsMixin, BaseHTTPRequestHandler):
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
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
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
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
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
        full = os.path.normpath(os.path.join(WEB_DIR, name))
        ext = os.path.splitext(name)[1].lower()
        if not full.startswith(WEB_DIR + os.sep) or not (os.path.isfile(full) and ext in STATIC_EXTS):
            # 前端路由回退：无扩展名的路径交给入口页（React Router 需要），带扩展名的一律 404
            if ext:
                self._send(404, b"Not Found", "text/plain; charset=utf-8")
                return
            name = "index.html"
            full = os.path.join(WEB_DIR, name)
            ext = ".html"
            if not os.path.isfile(full):
                self._send(404, b"Not Found", "text/plain; charset=utf-8")
                return
        content_types = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".ico": "image/x-icon",
            ".woff": "font/woff",
            ".woff2": "font/woff2",
            ".json": "application/json; charset=utf-8",
            ".map": "application/json; charset=utf-8",
            ".txt": "text/plain; charset=utf-8",
        }
        with open(full, "rb") as fh:
            data = fh.read()
        # 入口页每次校验；构建产物（文件名带 hash）长期缓存；其余缓存一天，用 ETag 支持 304
        is_entry = name == "index.html"
        is_hashed = name.startswith("assets/") and "-" in os.path.basename(name)
        cache_control = "no-cache" if is_entry else (
            "public, max-age=31536000, immutable" if is_hashed else "public, max-age=86400"
        )
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

        for verb, pattern, name in ROUTES:
            if verb != method:
                continue
            match = re.match(pattern, path)
            if match:
                getattr(self, name)(match, query)
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







    # ================================================================ 数据源





















    # ================================================================ 波次登记






    # ================================================================ 订单组台账


    # ================================================================ 动力电池登记














    # ================================================================ 每日存档



    # ================================================================ 经销商




    # ================================================================ 看板





    # ================================================================ 导航页看板






    # ================================================================ 看板总台





    # ================================================================ 预警 / 大屏 / 人效





    SCREEN_DEFAULT = {"items": ["overview", "progress", "labor", "volume", "trend"],
                      "interval": 15, "sound": True}





    # ================================================================ 人工作业量（按作业日期）








    # ================================================================ 组件取数



    # ================================================================ 用户 / 组 / 权限














    # ================================================================ 导出






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
