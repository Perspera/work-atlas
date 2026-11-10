# -*- coding: utf-8 -*-
"""v9 升级：ERP 回传字段、口径修正、自动归档、组件缩放、数据源归档查询。

可重复执行（幂等）。执行前自动备份数据库。

用法：
    python tools/migrations/upgrade_v9.py
"""
import os
import shutil
import sys
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, BASE)


def main():
    import archive_refresh
    import db
    import rules
    import server

    db_path = os.path.join(BASE, "data", "dashboard.db")
    if not os.path.exists(db_path):
        print("数据库不存在，请先启动一次服务：", db_path)
        return 1

    backup_dir = os.path.join(BASE, "data", "backup")
    os.makedirs(backup_dir, exist_ok=True)
    backup = os.path.join(
        backup_dir, "pre_upgrade_v9_%s.db" % datetime.now().strftime("%Y%m%d_%H%M%S")
    )
    shutil.copy2(db_path, backup)
    print("已备份：", backup)

    conn = db.init_db()
    print("ship_lines 已加 ERP 列：erp_required / erp_status / erp_message / erp_time")

    server.ensure_page_dashboards(conn)
    server.ensure_page_layouts_v9(conn)
    server.ensure_personal_erp_widgets(conn)
    print("总览/进度默认布局已补 ERP 组件（个人布局追加到底部，不动原有组件）")

    coverage = rules.coverage(conn, db.today_str())
    print(
        "今日口径：系统订单量 %d 行 / %.2f 万元；已组波(台账) %d 行 / %.2f 万元；待组波 %d 行 / %.2f 万元"
        % (
            coverage["today"]["lines"], coverage["today"]["amount"] / 10000,
            coverage["registered_all"]["lines"], coverage["registered_all"]["amount"] / 10000,
            coverage["unregistered"]["lines"], coverage["unregistered"]["amount"] / 10000,
        )
    )
    erp = conn.execute(
        "SELECT COALESCE(erp_status,'未记录') AS s, COUNT(*) AS n, COALESCE(SUM(amount),0) AS a "
        "FROM ship_lines GROUP BY s ORDER BY n DESC"
    ).fetchall()
    print("ERP 状态分布：", [(r["s"], r["n"], round((r["a"] or 0) / 10000, 2)) for r in erp])
    print("")
    print("升级完成：")
    print("  1) 看板口径已按“系统订单量=订单日期 / 已登记=台账 / 未复核=无复核且无出库”修正")
    print("  2) 新增 ERP 回传指标、状态维度、失败/未回传明细（总览/进度页已加）")
    print("  3) 扫描发现新增或内容变更时，自动覆盖受影响日期的订单组/人效归档")
    print("  4) 数据源页「每日归档」可查看明细、按日/区间导出 CSV")
    print("  5) 组件缩放后内容按新尺寸重绘")
    print("")
    print("提示：如果 ERP 列还是空的，去「数据源 → 立即扫描」强制重扫一次（会重新读取 Z: 的文件）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
