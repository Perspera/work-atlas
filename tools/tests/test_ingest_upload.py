# -*- coding: utf-8 -*-
"""下载机上传入库：令牌校验、文件名校验、落盘 + 立即入库。

用法：
    python tools/tests/test_ingest_upload.py
"""
import os
import shutil
import sys
import tempfile

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, BASE)

from api import wms_mixin  # noqa: E402
from backend.core import db  # noqa: E402
from backend.wms import ingest_token  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(("  [OK]   " if ok else "  [FAIL] ") + name + (("  " + str(detail)) if detail and not ok else ""))
    if not ok:
        FAILS.append(name)


SHIP_CSV = (
    "订单日期,波次号,订单组号,wms单号,wms单行号,交货地,状态,订单数量,拣货人\n"
    "2026-11-13,W001,G001,WMS001,1,某经销商,已全部发运,3,张三\n"
    "2026-11-13,W001,G002,WMS002,1,某经销商,未发运,1,李四\n"
).encode("utf-8")


class FakeHandler(wms_mixin.WmsMixin):
    """继承 WmsMixin（复用 _upload_name/_atomic_write），只覆盖请求层方法。"""

    def __init__(self, conn, body, headers):
        self.conn = conn
        self.body = body
        self.headers = headers
        self.user = None
        self.result = None

    def client_ip(self):
        return "127.0.0.1"

    def read_body(self, limit=0):
        if len(self.body) > limit:
            from api.runtime import ApiError
            raise ApiError(413, "请求体过大")
        return self.body

    def json_out(self, obj, status=200, headers=None):
        self.result = obj


def run_upload(handler_cls, conn, body, headers):
    from api import wms_mixin
    from api.runtime import ApiError

    handler = handler_cls(conn, body, headers)
    try:
        wms_mixin.WmsMixin.handle_ingest_upload_public(handler)
        return handler, None
    except ApiError as exc:
        return handler, exc


def main():
    tmp = tempfile.mkdtemp(prefix="ingest_upload_test_")
    src_dir = os.path.join(tmp, "share")
    os.makedirs(src_dir)
    old_db = (db.DB_PATH, db.DATA_DIR)
    old_conn = getattr(db._local, "conn", None)
    from api import wms_mixin
    old_config = wms_mixin.CONFIG
    conn = None
    try:
        db.DB_PATH = os.path.join(tmp, "dashboard.db")
        db.DATA_DIR = tmp
        db._local.conn = None
        conn = db.init_db()
        wms_mixin.CONFIG = {"source_dirs": [src_dir], "source_dir_fallbacks": [], "sample_dirs": []}

        # ---------------------------------------------------------- 令牌
        check("未配置令牌时 verify 返回 None", ingest_token.verify(conn, "x" * 40) is None)
        check("未配置时 status.configured 为假", ingest_token.status(conn)["configured"] is False)
        _, exc = run_upload(FakeHandler, conn, SHIP_CSV,
                            {"X-File-Name": "a.csv", "X-WMS-Token": "z" * 40})
        check("未配置令牌时上传 503", exc is not None and exc.status == 503, str(exc))
        made = ingest_token.rotate(conn)
        token = made["token"]
        check("生成令牌长度足够", len(token) >= 20, str(len(token)))
        check("正确令牌通过", ingest_token.verify(conn, token) is True)
        check("错误令牌拒绝", ingest_token.verify(conn, "y" * 40) is False)
        check("过短令牌拒绝", ingest_token.verify(conn, "short") is False)
        stored = db.get_meta(conn, ingest_token.TOKEN_META, "")
        check("库里只存 sha256", stored and stored != token and len(stored) == 64, str(stored)[:16])
        status = ingest_token.status(conn)
        check("status 不回传哈希/明文",
              status["configured"] is True and "sha256" not in str(status) and token not in str(status))
        check("status 带 created_at", bool(status.get("created_at")))

        # ---------------------------------------------------------- 文件名校验
        def name_of(headers):
            handler = FakeHandler(conn, b"x", headers)
            try:
                return wms_mixin.WmsMixin._upload_name(handler), None
            except Exception as exc:  # ApiError
                return None, exc

        got, _ = name_of({"X-File-Name": "%E5%87%BA%E5%BA%93-2026-11-13.xlsx"})
        check("URL 编码文件名解码", got == "出库-2026-11-13.xlsx", str(got))
        for bad, label in (
            ({}, "缺少请求头"),
            ({"X-File-Name": "a/b.xlsx"}, "含斜杠"),
            ({"X-File-Name": "..%5Cb.xlsx"}, "反斜杠"),
            ({"X-File-Name": ".hidden.xlsx"}, "点开头"),
            ({"X-File-Name": "x.exe"}, "扩展名不支持"),
            ({"X-File-Name": "x" * 300 + ".xlsx"}, "文件名过长"),
        ):
            got, exc = name_of(bad)
            check("非法文件名被拒：%s" % label, got is None and exc is not None, str(got))

        # ---------------------------------------------------------- 上传失败分支
        _, exc = run_upload(FakeHandler, conn, SHIP_CSV,
                            {"X-File-Name": "a.csv", "X-WMS-Token": "z" * 40})
        check("令牌错误 401", exc is not None and exc.status == 401, str(exc))

        _, exc = run_upload(FakeHandler, conn, b"",
                            {"X-File-Name": "a.csv", "X-WMS-Token": token})
        check("空文件 400", exc is not None and exc.status == 400, str(exc))

        # ---------------------------------------------------------- 成功上传即入库
        name = "【出库】出库流程节点时间跟踪(配送中心)-2026-11-13.csv"
        handler, exc = run_upload(FakeHandler, conn, SHIP_CSV,
                                  {"X-File-Name": name, "X-WMS-Token": token})
        check("上传成功", exc is None, str(exc))
        result = handler.result or {}
        check("响应 ok 且非排队", result.get("ok") is True and result.get("queued") is False, str(result)[:200])
        landed = os.path.join(src_dir, name)
        check("文件落到数据源目录", os.path.isfile(landed))
        if os.path.isfile(landed):
            check("落盘内容与上传一致", open(landed, "rb").read() == SHIP_CSV)
        check("没有残留 .part 临时文件",
              not [n for n in os.listdir(src_dir) if ".part-" in n], str(os.listdir(src_dir)))
        source = result.get("source_file") or {}
        check("source_files 记录状态 ok", source.get("status") == "ok", str(source))
        check("source_files 行数正确", source.get("rows") == 2, str(source.get("rows")))
        rows = conn.execute("SELECT COUNT(*) AS c FROM ship_lines").fetchone()["c"]
        check("ship_lines 立即入库 2 行", rows == 2, str(rows))
        check("响应带回导入行数", (result.get("report") or {}).get("imported") == 1, str(result.get("report")))
        marked = ingest_token.status(conn)
        check("记录最近上传", marked.get("last_upload_name") == name and bool(marked.get("last_upload_at")),
              str(marked))

        # 重复上传同一文件：内容未变，应被跳过而不是重复入库
        handler2, exc2 = run_upload(FakeHandler, conn, SHIP_CSV,
                                    {"X-File-Name": name, "X-WMS-Token": token})
        check("重复上传不报错", exc2 is None, str(exc2))
        rows2 = conn.execute("SELECT COUNT(*) AS c FROM ship_lines").fetchone()["c"]
        check("重复上传不产生重复行", rows2 == 2, str(rows2))
        check("重复上传 skipped 计数", (handler2.result or {}).get("report", {}).get("skipped") == 1,
              str((handler2.result or {}).get("report")))

        print("")
        if FAILS:
            print("失败 %d 项：%s" % (len(FAILS), "、".join(FAILS)))
            return 1
        print("全部通过。")
        return 0
    finally:
        wms_mixin.CONFIG = old_config
        db.DB_PATH, db.DATA_DIR = old_db
        db._local.conn = old_conn
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
