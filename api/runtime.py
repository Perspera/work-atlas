# -*- coding: utf-8 -*-
"""进程级共享状态：配置、日志、SSE 广播与接口错误类型。

放在独立模块里，避免 Mixin 反向 import server 造成循环依赖。
"""
import os
import queue
import sys
import threading
import time

from backend import config_loader, paths

BASE_DIR = paths.BASE_DIR
LOG_PATH = paths.LOG_PATH
CONFIG = config_loader.load()
COOKIE_NAME = "dash_session"
# 前端只有一份：React 版（frontend/ 源码，构建产物到 dist/），由 Python 托管。
WEB_DIR = os.path.normpath(os.path.join(BASE_DIR, CONFIG.get("web_dir") or "dist"))
STATIC_EXTS = {
    ".html", ".js", ".css", ".svg", ".png", ".jpg", ".jpeg", ".gif",
    ".webp", ".ico", ".woff", ".woff2", ".json", ".map", ".txt",
}
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
