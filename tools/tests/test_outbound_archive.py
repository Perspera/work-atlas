# -*- coding: utf-8 -*-
"""出库流程节点文件归档：保存/覆盖/筛选/日期区间/分页/导出。

用法：
    python tools/tests/test_outbound_archive.py
"""
import os
import shutil
import sqlite3
import sys
import tempfile

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, BASE)

import outbound_archive  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(("  [OK]   " if ok else "  [FAIL] ") + name + (("  " + str(detail)) if detail and not ok else ""))
    if not ok:
        FAILS.append(name)


def main():
    src = os.path.join(BASE, "data", "dashboard.db")
    tmp = tempfile.mkdtemp(prefix="outbound_test_")
    dst = os.path.join(tmp, "dashboard.db")
    shutil.copy2(src, dst)
    for suffix in ("-wal", "-shm"):
        if os.path.exists(src + suffix):
            shutil.copy2(src + suffix, dst + suffix)
    conn = sqlite3.connect(dst, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    old = (outbound_archive.DATA_DIR, outbound_archive.ARCHIVE_DIR, outbound_archive.ROWS_FILE)
    outbound_archive.DATA_DIR = tmp
    outbound_archive.ARCHIVE_DIR = os.path.join(tmp, "outbound_archive")
    outbound_archive.ROWS_FILE = os.path.join(outbound_archive.ARCHIVE_DIR, "rows.jsonl.gz")
    headers = ["订单日期", "订单组号", "状态", "金额"]
    rows = [
        headers,
        ["2026-11-03", "G1", "已全部发运", 100],
        ["2026-11-04", "G2", "未发运", 200],
        ["2026-11-05", "G3", "已全部发运", 300],
    ]
    path = os.path.join(tmp, "【出库】出库流程节点时间跟踪(配送中心)-2026-11-05.xlsx")
    try:
        with open(path, "wb") as fh:
            fh.write(b"test-file-v1")
        info = outbound_archive.save_from_sheets(conn, path, [("Sheet1", rows)])
        check("首次保存归档", info.get("archived") and info.get("rows") == 3, str(info))
        meta = outbound_archive.get_meta(conn, "2026-11-05")
        check("归档元数据表头正确", meta and meta["headers"] == headers, str(meta))
        check("日期列自动识别", meta and "订单日期" in meta["date_columns"], str(meta.get("date_columns") if meta else None))
        again = outbound_archive.save_from_sheets(conn, path, [("Sheet1", rows)])
        check("同内容不重复写入", again.get("skipped") is True, str(again))
        result = outbound_archive.query(conn, filters=[{"col": "状态", "op": "eq", "value": "已全部发运"}],
                                        date_col="订单日期", date_from="2026-11-03", date_to="2026-11-05",
                                        page=1, page_size=1, biz_date="2026-11-05")
        check("表头筛选 + 日期区间", result["total"] == 2, str(result["total"]))
        check("每页分页生效", len(result["rows"]) == 1 and result["pages"] == 2, str(result))
        export = outbound_archive.export_csv(conn, filters=[{"col": "状态", "op": "eq", "value": "已全部发运"}],
                                              biz_date="2026-11-05")
        check("筛选导出只含结果", len(export.decode("utf-8-sig").splitlines()) == 3, str(export[:80]))

        # 内容变化 -> 覆盖同一逻辑归档
        rows2 = [headers, ["2026-11-06", "G4", "已全部发运", 400]]
        with open(path, "wb") as fh:
            fh.write(b"test-file-v2")
        info2 = outbound_archive.save_from_sheets(conn, path, [("Sheet1", rows2)])
        meta2 = outbound_archive.get_meta(conn, "2026-11-05")
        check("变更后覆盖内容", info2.get("archived") and meta2["rows"] == 1, str(meta2 and meta2["rows"]))
        check("只保留一条归档记录", conn.execute("SELECT COUNT(*) AS c FROM outbound_archive").fetchone()["c"] == 1)
        print("")
        if FAILS:
            print("失败 %d 项：%s" % (len(FAILS), "、".join(FAILS)))
            return 1
        print("全部通过。")
        return 0
    finally:
        outbound_archive.DATA_DIR, outbound_archive.ARCHIVE_DIR, outbound_archive.ROWS_FILE = old
        conn.close()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
