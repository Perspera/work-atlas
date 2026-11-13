# -*- coding: utf-8 -*-
"""下载机上传入库令牌：生成、校验与状态。

令牌只以 sha256 形式落在 meta 表，明文仅在 rotate() 的返回值里出现一次。
未配置时 verify() 返回 None（区别于 False），调用方据此回 503 而不是 401。
"""
import hashlib
import hmac
import secrets

from backend.core import db

TOKEN_META = "ingest_token_sha256"
CREATED_AT_META = "ingest_token_created_at"
LAST_UPLOAD_AT_META = "last_upload_at"
LAST_UPLOAD_NAME_META = "last_upload_name"

TOKEN_MIN_LENGTH = 20


def _digest(token):
    return hashlib.sha256(str(token).encode("utf-8")).hexdigest()


def status(conn):
    """对外状态：只回是否已配置与时间戳，绝不回哈希或明文。"""
    stored = db.get_meta(conn, TOKEN_META, "") or ""
    return {
        "configured": bool(stored),
        "created_at": (db.get_meta(conn, CREATED_AT_META, "") or "") if stored else "",
        "last_upload_at": db.get_meta(conn, LAST_UPLOAD_AT_META, "") or "",
        "last_upload_name": db.get_meta(conn, LAST_UPLOAD_NAME_META, "") or "",
    }


def rotate(conn):
    """重新生成令牌，旧令牌立即失效。返回 {"token": 明文, "created_at": 时间}。"""
    token = secrets.token_urlsafe(32)
    created = db.now_str()
    db.set_meta(conn, TOKEN_META, _digest(token))
    db.set_meta(conn, CREATED_AT_META, created)
    return {"token": token, "created_at": created}


def verify(conn, token):
    """校验令牌。未配置 → None；配置了但不匹配 → False；匹配 → True。"""
    stored = db.get_meta(conn, TOKEN_META, "") or ""
    if not stored:
        return None
    given = str(token or "").strip()
    if len(given) < TOKEN_MIN_LENGTH:
        return False
    return hmac.compare_digest(_digest(given), stored)


def mark_upload(conn, name):
    """记录最近一次成功上传，供面板展示。"""
    db.set_meta(conn, LAST_UPLOAD_AT_META, db.now_str())
    db.set_meta(conn, LAST_UPLOAD_NAME_META, str(name or ""))
