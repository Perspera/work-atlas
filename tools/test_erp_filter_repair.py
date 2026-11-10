# -*- coding: utf-8 -*-
"""ERP 明细筛选修复单元测试：临时库副本，不碰线上数据。

用法：
    python tools/test_erp_filter_repair.py
"""
import json
import os
import shutil
import sqlite3
import sys
import tempfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

import db  # noqa: E402
import server  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(("  [OK]   " if ok else "  [FAIL] ") + name + (("  " + str(detail)) if detail and not ok else ""))
    if not ok:
        FAILS.append(name)


def main():
    src = os.path.join(BASE, "data", "dashboard.db")
    tmp = tempfile.mkdtemp(prefix="erp_filter_test_")
    dst = os.path.join(tmp, "dashboard.db")
    shutil.copy2(src, dst)
    for suffix in ("-wal", "-shm"):
        if os.path.exists(src + suffix):
            shutil.copy2(src + suffix, dst + suffix)
    conn = sqlite3.connect(dst, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        # 造一条带空 filter 的旧布局
        layout = {"widgets": [
            {"id": "pg-pr-erp-missing", "type": "table", "title": "未回传明细（订单组）",
             "spec": {"dataset": "erp_detail", "dimension": "", "metrics": ["rows"], "filter": {}}},
            {"id": "pg-pr-erp-failed", "type": "table", "title": "回传失败明细（订单组）",
             "spec": {"dataset": "erp_detail", "dimension": "", "metrics": ["rows"], "filter": {}}},
            {"id": "w-other", "type": "kpi", "title": "订单量",
             "spec": {"dataset": "orders", "metrics": ["rows"], "filter": {}}},
        ]}
        conn.execute("DELETE FROM dashboards WHERE page_key='progress' AND owner_user_id IS NULL")
        conn.execute(
            "INSERT INTO dashboards(name, page_key, owner_user_id, visibility, is_default, layout_json, version, updated_at) "
            "VALUES('进度','progress',NULL,'public',0,?,1,?)",
            (json.dumps(layout, ensure_ascii=False), db.now_str()),
        )
        conn.execute("DELETE FROM meta WHERE key='erp_filter_repair_v1'")

        server.ensure_erp_detail_filters(conn)
        row = conn.execute(
            "SELECT layout_json, version FROM dashboards WHERE page_key='progress' AND owner_user_id IS NULL"
        ).fetchone()
        widgets = {w["id"]: w for w in json.loads(row["layout_json"])["widgets"]}
        check("未回传组件补 missing",
              widgets["pg-pr-erp-missing"]["spec"]["filter"].get("erp_status") == "missing",
              str(widgets["pg-pr-erp-missing"]["spec"].get("filter")))
        check("失败组件补 failed",
              widgets["pg-pr-erp-failed"]["spec"]["filter"].get("erp_status") == "failed",
              str(widgets["pg-pr-erp-failed"]["spec"].get("filter")))
        check("其它组件不受影响",
              widgets["w-other"]["spec"].get("dataset") == "orders" and
              widgets["w-other"]["spec"].get("filter") == {})
        check("版本号 +1 并写迁移标记",
              row["version"] >= 2 and db.get_meta(conn, "erp_filter_repair_v1") == "1")

        conn.execute("DELETE FROM meta WHERE key='erp_filter_repair_v1'")
        server.ensure_erp_detail_filters(conn)
        row2 = conn.execute(
            "SELECT layout_json, version FROM dashboards WHERE page_key='progress' AND owner_user_id IS NULL"
        ).fetchone()
        check("第二次执行幂等（版本不再变化）", row2["version"] == row["version"],
              "%s vs %s" % (row2["version"], row["version"]))

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
