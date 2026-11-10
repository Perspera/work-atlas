# -*- coding: utf-8 -*-
"""看板初始化：公共示例看板、导航页默认看板与个人看板补种。

从 server.py 抽出，供启动流程与 DashboardMixin 共用，避免循环依赖。
"""
import json

import db
import templates


def ensure_default_dashboards(conn):
    """自定义画布的示例公共看板（page_key 为空）。"""
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM dashboards WHERE owner_user_id IS NULL AND page_key IS NULL"
    ).fetchone()
    if (row["c"] or 0) > 0:
        return
    for tpl in templates.TEMPLATES:
        layout = json.dumps({"widgets": tpl["widgets"]}, ensure_ascii=False)
        conn.execute(
            "INSERT INTO dashboards(name, owner_user_id, visibility, is_default, layout_json, version, updated_at) "
            "VALUES(?,NULL,'shared',?,?,1,?)",
            (tpl["name"], tpl.get("is_default", 0), layout, db.now_str()),
        )

PAGE_TEMPLATES = {item["key"]: item for item in templates.PAGE_TEMPLATES}

def ensure_page_dashboards(conn):
    """为每个导航页种下公共默认看板（只补缺，不覆盖已发布的版本）。"""
    for item in templates.PAGE_TEMPLATES:
        row = conn.execute(
            "SELECT id FROM dashboards WHERE page_key=? AND owner_user_id IS NULL",
            (item["key"],),
        ).fetchone()
        if row:
            continue
        layout = json.dumps({"widgets": item["widgets"]}, ensure_ascii=False)
        conn.execute(
            "INSERT INTO dashboards(name, owner_user_id, visibility, is_default, layout_json, "
            "version, updated_at, page_key) VALUES(?,NULL,'shared',1,?,1,?,?)",
            (item["name"], layout, db.now_str(), item["key"]),
        )

def ensure_user_dashboards(conn, user_id):
    """给用户一份自由画布的初始副本（页面看板不走这里）。"""
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM dashboards WHERE owner_user_id=? AND page_key IS NULL",
        (user_id,),
    ).fetchone()
    if (row["c"] or 0) > 0:
        return
    default = conn.execute(
        "SELECT * FROM dashboards WHERE owner_user_id IS NULL AND page_key IS NULL "
        "ORDER BY is_default DESC, id LIMIT 1"
    ).fetchone()
    if default:
        conn.execute(
            "INSERT INTO dashboards(name, owner_user_id, visibility, is_default, layout_json, version, updated_at) "
            "VALUES(?,?,'private',1,?,1,?)",
            (default["name"], user_id, default["layout_json"], db.now_str()),
        )
