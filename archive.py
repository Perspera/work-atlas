# -*- coding: utf-8 -*-
"""每日订单组存档：把当天的订单组台账冻结成按日期的快照。

- 手动：页面「存档今日 / 重新存档」（force=True 覆盖）
- 自动：跨天补档（已登记的旧业务日，若还没有存档且有数据，只补缺不覆盖）
"""
import db
import rules


def collect(conn, biz_date):
    """取当日全部订单组（含已移出），分页拼到内存。"""
    rows = []
    page = 1
    while True:
        data = rules.order_groups(
            conn, biz_date, None, True, mode="live", included="all",
            sort="reg", page=page, size=1000,
        )
        chunk = data.get("rows") or []
        rows.extend(chunk)
        if len(chunk) < 1000 or len(rows) >= (data.get("total") or 0):
            break
        page += 1
    return rows


def snapshot(conn, biz_date, user=None, force=False):
    """把某业务日的订单组台账写入 daily_archive。"""
    existing = conn.execute(
        "SELECT COUNT(*) AS c FROM daily_archive WHERE biz_date=?", (biz_date,)
    ).fetchone()["c"]
    if existing and not force:
        return {"ok": False, "reason": "exists", "count": existing}
    rows = collect(conn, biz_date)
    if not rows and not existing:
        return {"ok": False, "reason": "empty", "count": 0}

    now = db.now_str()
    uid = user["id"] if user else None
    payload = [
        (
            biz_date, row.get("seq") or index + 1, row["group_no"], row.get("wave_no"),
            row.get("dealer"), row.get("lines") or 0, row.get("amount") or 0,
            row.get("zone"), row.get("doc_type"), row.get("freight_free"),
            row.get("region"), row.get("route"), row.get("tms_status"),
            row.get("assignee"), row.get("note"),
            1 if row.get("included", 1) else 0, now, uid,
        )
        for index, row in enumerate(rows)
    ]
    with db.transaction(conn):
        conn.execute("DELETE FROM daily_archive WHERE biz_date=?", (biz_date,))
        conn.executemany(
            "INSERT INTO daily_archive(biz_date, seq, group_no, wave_no, dealer_short, lines, amount, "
            "zone, doc_type, freight_free, region, route, tms_status, assignee, note, included, "
            "archived_at, archived_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            payload,
        )
    db.bump_version(conn)
    return {"ok": True, "count": len(rows), "biz_date": biz_date, "replaced": bool(existing)}


def auto_archive(conn, user=None):
    """跨天补档：只补"还没有存档"的历史业务日。"""
    dates = [
        r["biz_date"]
        for r in conn.execute(
            "SELECT DISTINCT biz_date FROM wave_registry WHERE deleted_at IS NULL ORDER BY biz_date"
        )
    ]
    if not dates:
        return []
    latest = dates[-1]
    today = db.today_str()
    done = []
    for biz_date in dates:
        if not (biz_date < today or biz_date < latest):
            continue
        exists = conn.execute(
            "SELECT 1 FROM daily_archive WHERE biz_date=? LIMIT 1", (biz_date,)
        ).fetchone()
        if exists:
            continue
        result = snapshot(conn, biz_date, user, force=False)
        if result.get("ok"):
            done.append(biz_date)
    return done


def list_dates(conn):
    return [
        {"biz_date": r["biz_date"], "rows": r["n"], "archived_at": r["ts"]}
        for r in conn.execute(
            "SELECT biz_date, COUNT(*) AS n, MAX(archived_at) AS ts FROM daily_archive "
            "GROUP BY biz_date ORDER BY biz_date DESC"
        )
    ]


def get(conn, biz_date):
    rows = conn.execute(
        "SELECT * FROM daily_archive WHERE biz_date=? ORDER BY seq", (biz_date,)
    ).fetchall()
    return [dict(r) for r in rows]


def drop(conn, biz_date):
    conn.execute("DELETE FROM daily_archive WHERE biz_date=?", (biz_date,))
    db.bump_version(conn)
