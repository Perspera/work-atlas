# -*- coding: utf-8 -*-
"""兼容垫片：保留原有的 `python ingest.py --scan / --check` 命令行用法。

真正的实现在 `backend/collect/ingest.py`。README 与运维习惯都指向本文件。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend.collect.ingest import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
