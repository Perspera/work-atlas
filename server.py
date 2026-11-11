# -*- coding: utf-8 -*-
"""兼容垫片：保留原有的 `python server.py` 启动方式。

真正的实现在 `backend/server.py`。部署脚本（deploy/deploy.ps1 的 systemd
ExecStart）、`启动看板.bat`、README 里的命令都指向本文件，因此必须留在仓库根。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend.server import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
