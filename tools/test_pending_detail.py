# -*- coding: utf-8 -*-
"""待组波口径单元测试：空波次号行。

用法：
    python tools/test_pending_detail.py
"""
import os
import shutil
import sqlite3
import sys
import tempfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

import db  # noqa: E402
import rules  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(("  [OK]   " if ok else "  [FAIL] ") + name + (("  " + str(detail)) if detail and not ok else ""))
    if not ok:
        FAILS.append(name)


def main():
    src = os.path.join(BASE, "data", "dashboard.db")
    tmp = tempfile.mkdtemp(prefix="pending_test_")
    dst = os.path.join(tmp, "dashboard.db")
    shutil.copy2(src, dst)
    for suffix in ("-wal", "-shm"):
        if os.path.exists(src + suffix):
            shutil.copy2(src + suffix, dst + suffix)
    conn = sqlite3.connect(dst, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    day = "2099-01-01"
    try:
        base = rules.coverage(conn, day)
        check("空日期待组波为 0", base["pending"]["lines"] == 0, str(base["pending"]))
        conn.execute(
            "INSERT INTO ship_lines(order_date, wave_no, wms_no, group_no, dealer_full, amount, qty) "
            "VALUES(?,?,?,?,?,?,?)", (day, "", "TEST-WMS-1", "TEST-GROUP-1", "测试经销商", 100.0, 2)
        )
        conn.execute(
            "INSERT INTO ship_lines(order_date, wave_no, wms_no, group_no, dealer_full, amount, qty) "
            "VALUES(?,?,?,?,?,?,?)", (day, "WAVE-TEST-1", "TEST-WMS-2", "TEST-GROUP-2", "测试经销商", 200.0, 1)
        )
        cov = rules.coverage(conn, day)
        check("只统计空波次号行数", cov["pending"]["lines"] == 1, str(cov["pending"]))
        check("只统计空波次号金额", abs(cov["pending"]["amount"] - 100.0) < 0.001, str(cov["pending"]))
        check("覆盖率 = 非空波次占比", abs(cov["coverage_rate"] - 0.5) < 0.0001, str(cov["coverage_rate"]))
        detail = rules.pending_detail(conn, day, None, page=1, page_size=50)
        check("明细只包含空波次号行", detail["lines"] == 1 and detail["rows"][0]["wms_no"] == "TEST-WMS-1",
              str(detail["rows"]))
        check("明细分页字段", detail["page"] == 1 and detail["pages"] == 1, str(detail))
        print("")
        if FAILS:
            print("失败 %d 项：%s" % (len(FAILS), "、".join(FAILS)))
            return 1
        print("全部通过。")
        return 0
    finally:
        conn.close()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
