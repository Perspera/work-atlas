# -*- coding: utf-8 -*-
"""扫描后的自动归档：只重算「受影响日期」，其余日期保持原快照。

规则：
- 订单组登记：本轮新增/变更的行所属波次 → 该波次登记的业务日 → 整日台账快照覆盖
- 人工作业量：本轮新增/变更行涉及的拣货/复核日期 → 当日人效快照覆盖
- 另外始终执行「跨天补缺」（已有逻辑），保证新日期也有归档
"""
from backend.archives import archive
from backend.archives import battery_archive
from backend.core import db
from backend.archives import labor_archive


def affected_biz_dates(conn, waves):
    waves = [w for w in (waves or []) if w]
    if not waves:
        return []
    dates = set()
    for start in range(0, len(waves), 400):
        part = waves[start : start + 400]
        marks = ",".join("?" * len(part))
        for row in conn.execute(
            "SELECT DISTINCT biz_date FROM wave_registry WHERE deleted_at IS NULL "
            "AND wave_no IN (%s)" % marks,
            part,
        ):
            if row["biz_date"]:
                dates.add(row["biz_date"])
    return sorted(dates)


def refresh(conn, report, user=None):
    """按扫描报告里的受影响集合覆盖归档，并补齐缺失日期。"""
    report = report or {}
    added = int(report.get("added_rows") or 0)
    changed = int(report.get("changed_rows") or 0)
    result = {
        "orders": [],
        "labor": [],
        "orders_filled": [],
        "labor_filled": [],
        "battery": [],
        "battery_filled": [],
        "added_rows": added,
        "changed_rows": changed,
    }
    result_orders = result["orders"]
    result_labor = result["labor"]
    # 首次启用自动归档：给"今天"建基线快照（已存在则不覆盖）
    if db.get_meta(conn, "last_archive_scan") is None:
        today = db.today_str()
        snap = archive.snapshot(conn, today, user, force=False)
        if snap.get("ok"):
            result_orders.append(today)
        snap = labor_archive.snapshot(conn, today, user, force=False)
        if snap.get("ok"):
            result_labor.append(today)
    if added or changed:
        biz_dates = affected_biz_dates(conn, report.get("affected_waves"))
        for biz_date in biz_dates:
            snapshot = archive.snapshot(conn, biz_date, user, force=True)
            if snapshot.get("ok"):
                result["orders"].append(biz_date)
        work_dates = sorted(
            set(report.get("affected_pick_dates") or [])
            | set(report.get("affected_check_dates") or [])
        )
        for work_date in work_dates:
            snapshot = labor_archive.snapshot(conn, work_date, user, force=True)
            if snapshot.get("ok"):
                result["labor"].append(work_date)
    result["orders_filled"] = archive.auto_archive(conn, user)
    result["labor_filled"] = labor_archive.auto_archive(conn, user)
    result["battery_filled"] = battery_archive.auto_archive(conn, user)
    if result["orders"] or result["labor"] or result["battery_filled"]:
        db.set_meta(conn, "last_archive_scan", db.now_str())
        db.audit(
            conn, user, "", "archive.auto_refresh", "scan",
            "订单组=%s 人效=%s 电池=%s 新增=%d 变更=%d"
            % (",".join(result["orders"]), ",".join(result["labor"]),
               ",".join(result["battery_filled"]), added, changed),
        )
    return result
