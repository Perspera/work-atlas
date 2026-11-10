# -*- coding: utf-8 -*-
"""动力电池登记每日存档。"""
import csv
import io

import battery
import db


def collect(conn, biz_date):
    """实际登记日期的已确认行；订单日期可早于登记日期。"""
    data = battery.rows(conn, "", "", "", "confirmed", 1, 5000, True,
                        reg_from=biz_date, reg_to=biz_date)
    return data.get("rows") or []


def snapshot(conn, biz_date, user=None, force=False):
    existing = conn.execute(
        "SELECT COUNT(*) AS c FROM battery_daily_archive WHERE biz_date=?", (biz_date,)
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
            biz_date, row.get("reg_date") or biz_date, index + 1, row.get("order_date"), row.get("group_no"),
            row.get("dealer_full"), row.get("dealer_short"), row.get("part_code"),
            row.get("part_name"), row.get("lines") or 0, row.get("qty") or 0,
            row.get("amount") or 0, row.get("picked") or 0, row.get("checked") or 0,
            row.get("zone"), row.get("doc_type"), row.get("freight_free"),
            row.get("region"), row.get("carrier"), row.get("dest_city"),
            row.get("address"), 1 if row.get("address_matched") else 0,
            1 if row.get("confirmed") else 0, now, uid,
        )
        for index, row in enumerate(rows)
    ]
    with db.transaction(conn):
        conn.execute("DELETE FROM battery_daily_archive WHERE biz_date=?", (biz_date,))
        conn.executemany(
            "INSERT INTO battery_daily_archive(biz_date, reg_date, seq, order_date, group_no, dealer_full, "
            "dealer_short, part_code, part_name, lines, qty, amount, picked, checked, zone, "
            "doc_type, freight_free, region, carrier, dest_city, address, address_matched, "
            "confirmed, archived_at, archived_by) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            payload,
        )
    db.bump_version(conn)
    return {"ok": True, "count": len(rows), "biz_date": biz_date, "replaced": bool(existing)}


def auto_archive(conn, user=None):
    """只补历史日期中尚无存档的电池快照，不覆盖已有存档。"""
    dates = [r["d"] for r in conn.execute(
        "SELECT DISTINCT reg_date AS d FROM battery_confirmations "
        "WHERE reg_date IS NOT NULL AND reg_date <> '' ORDER BY reg_date"
    )]
    today = db.today_str()
    done = []
    for day in dates:
        if day >= today:
            continue
        if conn.execute("SELECT 1 FROM battery_daily_archive WHERE biz_date=? LIMIT 1", (day,)).fetchone():
            continue
        result = snapshot(conn, day, user, force=False)
        if result.get("ok"):
            done.append(day)
    return done


def list_dates(conn):
    return [dict(r) for r in conn.execute(
        "SELECT biz_date, COUNT(*) AS rows, MAX(archived_at) AS archived_at "
        "FROM battery_daily_archive GROUP BY biz_date ORDER BY biz_date DESC"
    )]


def query(conn, date_from="", date_to="", q="", status="", page=1, page_size=50):
    page = max(1, int(page or 1))
    page_size = max(1, min(200, int(page_size or 50)))
    conds, params = [], []
    if date_from:
        conds.append("biz_date >= ?")
        params.append(date_from)
    if date_to:
        conds.append("biz_date <= ?")
        params.append(date_to)
    if q:
        like = "%" + str(q).strip() + "%"
        conds.append("(group_no LIKE ? OR dealer_full LIKE ? OR dealer_short LIKE ? OR part_code LIKE ? OR part_name LIKE ?)")
        params.extend([like] * 5)
    if str(status) in ("confirmed", "pending"):
        conds.append("confirmed = ?")
        params.append(1 if str(status) == "confirmed" else 0)
    where = (" WHERE " + " AND ".join(conds)) if conds else ""
    total = conn.execute("SELECT COUNT(*) AS c FROM battery_daily_archive" + where, params).fetchone()["c"]
    pages = max(1, (total + page_size - 1) // page_size)
    page = min(page, pages)
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM battery_daily_archive" + where +
        " ORDER BY biz_date DESC, seq LIMIT ? OFFSET ?",
        params + [page_size, (page - 1) * page_size],
    )]
    summary = conn.execute(
        "SELECT COALESCE(SUM(lines),0) AS lines, COALESCE(SUM(qty),0) AS qty, "
        "COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(picked),0) AS picked, "
        "COALESCE(SUM(checked),0) AS checked FROM battery_daily_archive" + where, params
    ).fetchone()
    return {"total": total, "page": page, "page_size": page_size, "pages": pages,
            "rows": rows, "summary": dict(summary)}


def export_csv(conn, date_from="", date_to="", q="", status=""):
    data = query(conn, date_from, date_to, q, status, 1, 5000)
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["登记日期", "订单日期", "订单组号", "经销商", "备件编码", "备件名称", "行数", "数量", "金额",
                     "拣货行数", "复核行数", "库区", "单据类型", "是否免运费", "区域", "承运商",
                     "送达城市", "地址", "状态", "存档时间"])
    for r in data["rows"]:
        writer.writerow([
            r.get("reg_date") or r.get("biz_date"), r.get("order_date"), r.get("group_no"),
            r.get("dealer_short") or r.get("dealer_full"), r.get("part_code"), r.get("part_name"),
            r.get("lines"), r.get("qty"), r.get("amount"), r.get("picked"), r.get("checked"),
            r.get("zone"), r.get("doc_type"), r.get("freight_free"), r.get("region"),
            r.get("carrier"), r.get("dest_city"), r.get("address"),
            "已登记" if r.get("confirmed") else "待登记", r.get("archived_at"),
        ])
    return out.getvalue().encode("utf-8-sig")
