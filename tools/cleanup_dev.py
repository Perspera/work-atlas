# -*- coding: utf-8 -*-
"""开发期清理：删除测试账号、测试备注，恢复成干净的交付状态。

用法：python tools/cleanup_dev.py
保留：管理员账号、样本数据、波次登记、经销商映射、公共看板模板。
"""
import os
import sqlite3
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(BASE, "data", "dashboard.db")


def main():
    if not os.path.exists(DB):
        print("数据库不存在，跳过")
        return 0
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.execute("UPDATE wave_registry SET note=''")
    for name in ("yue", "clerk"):
        row = conn.execute("SELECT id FROM users WHERE username=?", (name,)).fetchone()
        if not row:
            continue
        uid = row["id"]
        for sql in (
            "DELETE FROM user_permissions WHERE user_id=?",
            "DELETE FROM group_members WHERE user_id=?",
            "DELETE FROM data_scopes WHERE owner_type='user' AND owner_id=?",
            "DELETE FROM sessions WHERE user_id=?",
            "DELETE FROM users WHERE id=?",
        ):
            conn.execute(sql, (uid,))
    conn.execute("DELETE FROM dashboards WHERE owner_user_id IS NOT NULL")
    conn.execute("DELETE FROM login_attempts")
    conn.commit()
    users = [r["username"] for r in conn.execute("SELECT username FROM users")]
    print("剩余账号：", users)
    print("公共看板：", conn.execute("SELECT COUNT(*) FROM dashboards").fetchone()[0])
    print(
        "已登记波次：",
        conn.execute(
            "SELECT COUNT(*) FROM wave_registry WHERE deleted_at IS NULL"
        ).fetchone()[0],
    )
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
