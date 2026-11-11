# -*- coding: utf-8 -*-
"""发运明细身份回归：订单组号变化时更新原行，不新增重复行。"""
import os
import shutil
import sys
import tempfile

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, BASE)

from backend.core import db  # noqa: E402
from backend.collect import ingest  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(("  [OK]   " if ok else "  [FAIL] ") + name + (("  " + str(detail)) if detail and not ok else ""))
    if not ok:
        FAILS.append(name)


def main():
    tmp = tempfile.mkdtemp(prefix="ship_identity_test_")
    old_path, old_data = db.DB_PATH, db.DATA_DIR
    old_local = db._local
    db.DB_PATH = os.path.join(tmp, "dashboard.db")
    db.DATA_DIR = tmp
    db._local = type("L", (), {})()
    try:
        conn = db.init_db()
        def row(group, amount):
            data = {name: None for name in ingest.SHIP_FP_FIELDS}
            data.update({
                "order_date": "2026-11-06", "wave_no": "W1", "wms_no": "X100",
                "line_no": "00001", "group_no": group, "amount": amount,
                "qty": 1.0, "status": "待运", "part_code": "P1", "part_name": "测试件",
                "pick_qty": 0.0, "out_qty": 0.0, "mode": "", "warehouse": "",
            })
            return data
        ingest._upsert_ship(conn, [row("", 1.0)], 1)
        check("空订单组先入库", conn.execute("SELECT COUNT(*) AS c FROM ship_lines").fetchone()["c"] == 1)
        ingest._upsert_ship(conn, [row("G-FINAL", 2.0)], 2)
        rec = conn.execute("SELECT COUNT(*) AS c, MIN(group_no) AS g, MIN(amount) AS a FROM ship_lines").fetchone()
        check("空组→正式组只保留一行", rec["c"] == 1, str(dict(rec)))
        check("订单组以最新源为准", rec["g"] == "G-FINAL", str(rec["g"]))
        check("金额随最新源更新", abs((rec["a"] or 0) - 2.0) < 0.001, str(rec["a"]))
        ingest._upsert_ship(conn, [row("G-NEW", 3.0)], 3)
        rec = conn.execute("SELECT group_no, amount FROM ship_lines").fetchone()
        check("正式组→正式组覆盖", rec["group_no"] == "G-NEW" and abs(rec["amount"] - 3.0) < 0.001,
              str(dict(rec)))
        print("")
        if FAILS:
            print("失败 %d 项：%s" % (len(FAILS), "、".join(FAILS)))
            return 1
        print("全部通过。")
        return 0
    finally:
        db.DB_PATH, db.DATA_DIR, db._local = old_path, old_data, old_local
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
