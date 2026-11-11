# -*- coding: utf-8 -*-
"""全项目唯一的路径锚点。

历史背景：重构前 ``db.py`` / ``ingest.py`` / ``source_archive.py`` /
``outbound_archive.py`` / ``config_loader.py`` / ``wms_manage.py`` 各自用
``os.path.dirname(os.path.abspath(__file__))`` 作为 BASE_DIR。这些模块被移入
``backend/`` 子包后，``__file__`` 变深了，若沿用原写法会把 ``data/``、
``config.json``、``tools/`` 指到子目录里去（服务会用空库启动）。

因此所有需要「仓库根」的模块统一从本文件取路径，不再自己算 ``__file__``。
"""
import os

#: 仓库根目录（本文件位于 <repo>/backend/paths.py，向上两级）
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DATA_DIR = os.path.join(BASE_DIR, "data")
BACKUP_DIR = os.path.join(DATA_DIR, "backup")
DB_PATH = os.path.join(DATA_DIR, "dashboard.db")
LOG_PATH = os.path.join(DATA_DIR, "server.log")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")

SOURCE_ARCHIVE_DIR = os.path.join(DATA_DIR, "source_archive")
OUTBOUND_ARCHIVE_DIR = os.path.join(DATA_DIR, "outbound_archive")

#: WMS 自动下载脚本所在目录
WMS_TOOLS_DIR = os.path.join(BASE_DIR, "tools", "wms_download")
