# -*- coding: utf-8 -*-
"""配置加载。"""
import json
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")

DEFAULTS = {
    "source_dirs": [],
    "source_dir_fallbacks": [],
    "sample_dirs": ["样本"],
    "port": 8787,
    "bind": "0.0.0.0",
    "scan_sec": 60,
    "cutoff_time": "16:00",
    "session_hours": 12,
    "backup_keep_days": 30,
    "allow_setup": True,
    "site_title": "单量与作业进度看板",
}


def load():
    data = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8-sig") as fh:
                data = json.load(fh)
        except Exception:
            data = {}
    cfg = dict(DEFAULTS)
    cfg.update(data or {})
    return cfg


def save(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
