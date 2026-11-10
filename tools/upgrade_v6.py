# -*- coding: utf-8 -*-
"""v6 升级脚本：看板总台 + 人工作业量（拣/复分开、按作业日期、归档）。

可重复执行（幂等）。执行前自动备份数据库。

用法：
    python tools/upgrade_v6.py
"""
import os
import shutil
import sys
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)


def main():
    import db
    import labor_archive
    import rules
    import server
    import templates

    db_path = os.path.join(BASE, "data", "dashboard.db")
    if not os.path.exists(db_path):
        print("数据库不存在，请先启动一次服务：", db_path)
        return 1

    backup_dir = os.path.join(BASE, "data", "backup")
    os.makedirs(backup_dir, exist_ok=True)
    backup = os.path.join(
        backup_dir, "pre_upgrade_v6_%s.db" % datetime.now().strftime("%Y%m%d_%H%M%S")
    )
    shutil.copy2(db_path, backup)
    print("已备份：", backup)

    conn = db.init_db()
    print("表结构已升级：labor_adjust(role) / labor_archive / dashboards(page_key)")

    server.ensure_page_dashboards(conn)
    server.ensure_page_layouts_v6(conn)
    print("导航页默认看板就绪；人工作业量默认布局升级为 v6（拣/复分开）")

    # 历史作业日期自动补档（只补缺，不覆盖）
    done = labor_archive.auto_archive(conn)
    if done:
        print("已自动补档的人效日期：", "、".join(done))
    else:
        print("人效归档：没有需要补档的历史作业日期")

    totals = rules.labor_stats(conn, db.today_str())
    print(
        "今日人效：拣货 %d 行 / %.1fh → %s 行/小时；复核 %d 行 / %.1fh → %s 行/小时"
        % (
            totals["totals"]["pick_rows"], totals["totals"]["pick_hours"] or 0,
            totals["totals"]["pick_rate"], totals["totals"]["check_rows"],
            totals["totals"]["check_hours"] or 0, totals["totals"]["check_rate"],
        )
    )
    print("")
    print("升级完成：")
    print("  1) 「看板总台」列出 5 个导航页看板 + 专题看板，点编辑→发布即可更新对应页面")
    print("  2) 人工作业量按作业日期统计，拣货/复核分开计数与人效，人效=行数÷有效作业小时")
    print("  3) 人工作业量页可切「实时/存档」；跨天会自动补档，也可「存档本日/重新存档」")
    return 0


if __name__ == "__main__":
    sys.exit(main())
