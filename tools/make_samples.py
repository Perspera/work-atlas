# -*- coding: utf-8 -*-
"""从现行工作簿生成接入样本（回归验证用）。

用法：
    python tools/make_samples.py [源工作簿路径]

产出（写入 样本/ 目录）：
    WMS发运表_<日期>.csv      发运表全列
    TMS运输单状态_<日期>.csv   运输单状态全列
    dealers.xlsx              经销商映射（全称/简称/区域/承运商；可含动力电池 sheet）
    waves_<日期>.txt          当天登记的波次号，一行一个
"""
import csv
import os
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(BASE_DIR, "样本")

DEFAULT_SOURCES = [
    r"C:\Users\Administrator\Desktop\deepseek\单据登记交接表.xlsx",
    r"Z:\单据登记\单据登记交接表.xlsm",
]


def pick_source(argv):
    if argv:
        return argv[0]
    for path in DEFAULT_SOURCES:
        if os.path.exists(path):
            return path
    raise SystemExit("找不到源工作簿，请把路径作为参数传入")


def trim_row(row):
    values = list(row)
    while values and (values[-1] is None or str(values[-1]).strip() == ""):
        values.pop()
    return values


def dump_sheet(wb, sheet_name, out_path):
    sheet = wb[sheet_name]
    rows = sheet.iter_rows(values_only=True)
    header = trim_row(next(rows))
    count = 0
    with open(out_path, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(header)
        for row in rows:
            values = list(row)[: len(header)]
            while len(values) < len(header):
                values.append(None)
            if all(v is None or str(v).strip() == "" for v in values):
                continue
            writer.writerow(["" if v is None else v for v in values])
            count += 1
    return count


def dump_dealers(wb, out_path):
    from openpyxl import Workbook

    sheet = wb["发车时间"]
    rows = sheet.iter_rows(values_only=True)
    next(rows)  # 表头：序号/全称/简称/区域
    out = Workbook()
    ws = out.active
    ws.title = "dealers"
    ws.append(["全称", "简称", "区域", "承运商"])
    count = 0
    for row in rows:
        values = list(row) + [None] * 6
        full, short, region, carrier = values[1], values[2], values[3], values[4]
        if not full or not str(full).strip():
            continue
        ws.append([
            str(full).strip(),
            str(short).strip() if short else str(full).strip(),
            str(region).strip() if region else "",
            str(carrier).strip() if carrier else "",
        ])
        count += 1
    out.save(out_path)
    out.close()
    return count


def dump_waves(wb, out_path):
    sheet = wb["波次登记"]
    waves = []
    for row in sheet.iter_rows(min_col=14, max_col=14, values_only=True):
        value = row[0] if row else None
        if value and str(value).strip().upper().startswith("WAVE"):
            waves.append(str(value).strip())
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(waves))
    return len(waves)


def main(argv):
    source = pick_source(argv)
    os.makedirs(OUT_DIR, exist_ok=True)
    from openpyxl import load_workbook

    print("源工作簿：", source)
    wb = load_workbook(source, read_only=True, data_only=True)
    try:
        wave_file = os.path.join(OUT_DIR, "waves_2026-09-05.txt")
        count = dump_waves(wb, wave_file)
        print("  波次登记：%d 个 → %s" % (count, os.path.basename(wave_file)))

        ship_file = os.path.join(OUT_DIR, "WMS发运表_20260905.csv")
        count = dump_sheet(wb, "发运表", ship_file)
        print("  发运表：%d 行 → %s" % (count, os.path.basename(ship_file)))

        tms_file = os.path.join(OUT_DIR, "TMS运输单状态_20260905.csv")
        count = dump_sheet(wb, "运输单状态", tms_file)
        print("  运输单状态：%d 行 → %s" % (count, os.path.basename(tms_file)))

        dealer_file = os.path.join(OUT_DIR, "dealers.xlsx")
        count = dump_dealers(wb, dealer_file)
        print("  经销商映射：%d 条 → %s" % (count, os.path.basename(dealer_file)))
    finally:
        wb.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
