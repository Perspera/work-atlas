# -*- coding: utf-8 -*-
"""动力电池登记口径测试：订单组 + 备件编码聚合、地址匹配、确认状态、备件表。"""
import os
import sys
import tempfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

import battery  # noqa: E402
import db  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(("  [OK]   " if ok else "  [FAIL] ") + name + (("  " + str(detail)) if detail and not ok else ""))
    if not ok:
        FAILS.append(name)


def main():
    conn = db.connect()
    date = "2026-11-06"
    before = battery.rows(conn, date, date, "", "", 1, 100, True)
    check("动力电池候选按订单组+编码列出", before["total"] >= 9, str(before["total"]))
    check("同一订单组同一编码只出现一次",
          len({(r["order_date"], r["group_no"], r["part_code"]) for r in before["rows"]}) == len(before["rows"]))
    first = before["rows"][0]
    check("经销商按订单组带出", bool(first.get("dealer_full")), str(first.get("dealer_full")))
    check("地址按经销商带出", bool(first.get("address_matched")), str(first.get("address")))
    check("显示备件名称", bool(first.get("part_name")), str(first.get("part_name")))
    check("数量/金额为正", (first.get("qty") or 0) > 0 and (first.get("amount") or 0) > 0,
          "%s / %s" % (first.get("qty"), first.get("amount")))
    item = {k: first[k] for k in ("order_date", "group_no", "part_code")}
    result = battery.confirm(conn, [item], 1)
    check("可人工确认登记", result.get("confirmed") == 1, str(result))
    confirmed = battery.rows(conn, date, date, first["group_no"], "confirmed", 1, 100, True)
    check("确认后状态为已登记",
          confirmed["total"] == 1 and confirmed["rows"][0]["confirmed"] == 1,
          str(confirmed["total"]))
    removed = battery.unconfirm(conn, [item])
    check("可取消登记", removed.get("removed") == 1, str(removed))

    prior = [dict(r) for r in conn.execute("SELECT part_code FROM battery_parts").fetchall()]
    tmp = tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8-sig")
    try:
        tmp.write("备件编码,备件名称\n")
        tmp.write("%s,备件表名称\n" % first["part_code"])
        tmp.close()
        count = battery.import_parts(conn, tmp.name)
        check("备件编码表可导入", count >= 1, str(count))
        bounded = battery.rows(conn, date, date, "", "", 1, 100, True)
        check("导入备件表后只保留表内编码", bounded["has_parts"] is True, str(bounded["has_parts"]))
        check("备件名称优先取备件表",
              any(r["part_name"] == "备件表名称" for r in bounded["rows"]),
              str([r["part_name"] for r in bounded["rows"][:3]]))
    finally:
        os.unlink(tmp.name)
        conn.execute("DELETE FROM battery_parts")
        conn.commit()

    print("")
    if FAILS:
        print("失败 %d 项：%s" % (len(FAILS), "、".join(FAILS)))
        return 1
    print("全部通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
