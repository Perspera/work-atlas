# -*- coding: utf-8 -*-
"""人工作业量每日归档：按「作业日期 × 人 × 工种」冻结当天汇总。

- 手动：人工作业量页「存档本日 / 重新存档」（force=True 覆盖）
- 自动：跨天补档（有人员作业数据、但还没有归档的旧作业日期，只补缺不覆盖）
"""
from backend.core import db
from backend.domain import rules


def collect(conn, biz_date, user_id=None):
    return rules.labor_archive_rows(conn, biz_date, user_id)


def snapshot(conn, biz_date, user=None, force=False):
    existing = conn.execute(
        "SELECT COUNT(*) AS c FROM labor_archive WHERE biz_date=?", (biz_date,)
    ).fetchone()["c"]
    if existing and not force:
        return {"ok": False, "reason": "exists", "count": existing}
    rows = collect(conn, biz_date)
    rows = [r for r in rows if (r["rows"] or 0) > 0]
    if not rows and not existing:
        return {"ok": False, "reason": "empty", "count": 0}

    now = db.now_str()
    uid = user["id"] if user else None
    payload = [
        (
            biz_date, r["person"], r["role"], r["rows"] or 0, r["groups"] or 0,
            r["hours_auto"] or 0, r["hours_used"] or 0, r["rate"], now, uid,
        )
        for r in rows
    ]
    with db.transaction(conn):
        conn.execute("DELETE FROM labor_archive WHERE biz_date=?", (biz_date,))
        conn.executemany(
            "INSERT INTO labor_archive(biz_date, person, role, rows, groups, hours_auto, "
            "hours_used, rate, archived_at, archived_by) VALUES(?,?,?,?,?,?,?,?,?,?)",
            payload,
        )
    db.bump_version(conn)
    return {"ok": True, "count": len(rows), "biz_date": biz_date, "replaced": bool(existing)}


def auto_archive(conn, user=None):
    """跨天补档：有人员作业数据、但还没有归档的历史作业日期。"""
    today = db.today_str()
    dates = [
        r["d"]
        for r in conn.execute(
            "SELECT DISTINCT substr(pick_time,1,10) AS d FROM ship_lines "
            "WHERE pick_time <> '' AND pick_person IS NOT NULL AND pick_person <> '' "
            "UNION "
            "SELECT DISTINCT substr(check_time,1,10) AS d FROM ship_lines "
            "WHERE check_time <> '' AND check_person IS NOT NULL AND check_person <> ''"
        )
        if r["d"] and r["d"] < today
    ]
    done = []
    for biz_date in sorted(set(dates)):
        exists = conn.execute(
            "SELECT 1 FROM labor_archive WHERE biz_date=? LIMIT 1", (biz_date,)
        ).fetchone()
        if exists:
            continue
        result = snapshot(conn, biz_date, user, force=False)
        if result.get("ok"):
            done.append(biz_date)
    return done


def list_dates(conn):
    return rules.labor_archive_dates(conn)


def get(conn, biz_date):
    return rules.labor_archive_get(conn, biz_date)


def drop(conn, biz_date):
    conn.execute("DELETE FROM labor_archive WHERE biz_date=?", (biz_date,))
    db.bump_version(conn)
