# -*- coding: utf-8 -*-
"""v8 升级：数据集补金额/组波字段；取消所有按组统计的指标；编辑时不再自动刷新。

可重复执行（幂等）。执行前自动备份数据库。

用法：
    python tools/migrations/upgrade_v8.py
"""
import os
import shutil
import sys
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, BASE)


def main():
    from backend.core import db
    from backend.domain import rules
    from backend import server
    from backend.domain import widgets

    db_path = os.path.join(BASE, "data", "dashboard.db")
    if not os.path.exists(db_path):
        print("数据库不存在，请先启动一次服务：", db_path)
        return 1

    backup_dir = os.path.join(BASE, "data", "backup")
    os.makedirs(backup_dir, exist_ok=True)
    backup = os.path.join(
        backup_dir, "pre_upgrade_v8_%s.db" % datetime.now().strftime("%Y%m%d_%H%M%S")
    )
    shutil.copy2(db_path, backup)
    print("已备份：", backup)

    conn = db.init_db()
    server.ensure_page_dashboards(conn)
    server.ensure_page_layouts_v8(conn)
    print("页面默认布局已更新（今日订单量/金额、已组波行数/金额、待组波行数/金额）")
    print("已从所有看板清掉按组统计的指标（订单组数/今日订单量(组)/漏登记(组) 等）")

    coverage = rules.coverage(conn, db.today_str())
    print(
        "今日覆盖：共 %d 行 / %.2f 万元；已组波 %d 行 / %.2f 万元；待组波 %d 行 / %.2f 万元"
        % (
            coverage["today"]["lines"], coverage["today"]["amount"] / 10000,
            coverage["registered_today"]["lines"],
            coverage["registered_today"]["amount"] / 10000,
            coverage["unregistered"]["lines"], coverage["unregistered"]["amount"] / 10000,
        )
    )
    print("可配置指标（已无按组）：", "、".join(widgets.METRIC_META))
    print("")
    print("升级完成：")
    print("  1) 数据集「今日订单量/登记覆盖」新增：金额、已组波行数/金额、待组波行数/金额")
    print("  2) 组件库不再提供任何按组统计的指标（行数/金额/进度比例为主）")
    print("  3) 编辑看板/组件期间页面不再自动刷新，避免操作被打断")
    return 0


if __name__ == "__main__":
    sys.exit(main())
