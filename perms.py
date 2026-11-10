# -*- coding: utf-8 -*-
"""权限点字典与角色预设。

- 权限点是原子的、可逐项分配的；角色只是"预设模板"，最终判定只看权限点。
- 用户可属多个组，组权限并集 + 用户直接追加 - 用户直接拒绝（拒绝优先）。
"""

# (code, group, title, description)
PERMISSIONS = [
    # 页面
    ("page.overview", "页面", "今日总览", "查看总览页"),
    ("page.progress", "页面", "作业进度", "查看作业进度页"),
    ("page.volume", "页面", "单量分析", "查看单量分析页"),
    ("page.trend", "页面", "趋势分析", "查看趋势页"),
    ("page.waves", "页面", "波次登记", "查看波次登记页"),
    ("page.orders", "页面", "订单组登记", "查看订单组台账（含每日存档）"),
    ("page.battery", "页面", "动力电池登记", "查看动力电池订单组登记"),
    ("page.labor", "页面", "人工作业量", "查看人工作业量/人效页"),
    ("page.alerts", "页面", "预警中心", "查看预警消息与线路预警状态"),
    ("page.screen", "页面", "大屏模式", "打开大屏轮播页面"),
    ("page.sources", "页面", "数据源", "查看数据源与导入状态"),
    ("page.dashboard", "页面", "自定义看板", "查看/进入自定义看板"),
    ("page.users", "页面", "用户与权限", "用户、组、权限管理页"),
    ("page.audit", "页面", "审计日志", "查看操作审计"),

    # 组件
    ("widget.kpi", "组件", "KPI 卡", "使用 KPI 卡组件"),
    ("widget.bar", "组件", "柱状图", "使用柱状图组件"),
    ("widget.line", "组件", "折线图", "使用折线图组件"),
    ("widget.pie", "组件", "饼/环图", "使用饼图/环形图组件"),
    ("widget.funnel", "组件", "漏斗图", "使用漏斗图组件"),
    ("widget.table", "组件", "表格", "使用表格组件"),
    ("widget.detail", "组件", "明细列表", "使用明细列表组件"),
    ("widget.alert", "组件", "预警清单", "使用预警组件"),
    ("widget.progress", "组件", "进度条", "使用进度条组件"),
    ("widget.text", "组件", "文本说明", "使用文本说明组件"),

    # 动作
    ("action.waves.create", "动作", "新增波次登记", "登记当天要发运的波次"),
    ("action.waves.update", "动作", "修改波次登记", "改备注/改指派承运商"),
    ("action.waves.delete", "动作", "删除波次登记", "软删除已登记波次"),
    ("action.orders.override", "动作", "修改订单组明细", "改区域/承运商/指派/备注，移出或恢复订单组"),
    ("action.battery.manage", "动作", "动力电池登记", "确认/取消动力电池订单组登记，维护备件编码表"),
    ("action.orders.archive", "动作", "每日存档", "按日期存档订单组台账、重新存档"),
    ("action.labor.adjust", "动作", "校正工时", "人工修正某人当天实际工时"),
    ("action.labor.archive", "动作", "人效归档", "按作业日期存档人工作业量、重新存档"),
    ("action.labor.settings", "动作", "作业设置", "维护相邻作业间隔阈值与全局休息时段"),
    ("action.alerts.manage", "动作", "预警规则与负责人", "配线路截止时间、指定负责人"),
    ("action.screen.config", "动作", "大屏配置", "配大屏轮播清单与间隔"),
    ("action.scan", "动作", "立即扫描数据源", "手动触发数据重新导入"),
    ("action.dealers.manage", "动作", "维护经销商映射", "导入/编辑 全称-简称-区域-线路"),
    ("action.dashboard.edit", "动作", "编辑看板布局", "拖拽、增删、配置组件"),
    ("action.dashboard.publish", "动作", "发布公共看板", "把布局发布为全员模板"),
    ("action.export", "动作", "导出/打印", "打印单量表版式、导出 CSV"),
    ("action.users.manage", "动作", "管理用户与权限", "建用户/组、分配权限与数据范围"),
    ("action.users.resetpwd", "动作", "重置他人密码", "给用户重置为临时密码"),
    ("action.audit.view", "动作", "查看审计日志", "查询操作记录"),

    # 字段与数据
    ("field.amount", "字段", "查看金额", "金额（元/万元）相关指标"),
    ("field.dealer_full", "字段", "查看经销商全称", "经销商完整名称"),
    ("field.part_cost", "字段", "查看备件单价", "备件单价类字段"),
    ("data.unmapped", "数据", "查看未映射数据", "未映射经销商/未匹配运输单"),
]

PERM_CODES = [p[0] for p in PERMISSIONS]
PERM_GROUP = {p[0]: p[1] for p in PERMISSIONS}
PERM_TITLE = {p[0]: p[2] for p in PERMISSIONS}

# 角色预设（只是新建用户时的勾选模板）
PRESETS = {
    "admin": set(PERM_CODES),
    "editor": set(PERM_CODES) - {
        "page.users",
        "page.audit",
        "action.users.manage",
        "action.users.resetpwd",
        "action.audit.view",
        "action.dashboard.publish",
        "action.dealers.manage",
        "action.alerts.manage",
        "action.screen.config",
    },
    "viewer": {
        "page.overview",
        "page.progress",
        "page.volume",
        "page.trend",
        "page.labor",
        "page.alerts",
        "page.screen",
        "page.waves",
        "page.orders",
        "page.battery",
        "page.dashboard",
        "widget.kpi",
        "widget.bar",
        "widget.line",
        "widget.pie",
        "widget.funnel",
        "widget.table",
        "widget.detail",
        "widget.alert",
        "widget.progress",
        "widget.text",
        "action.export",
        "field.amount",
    },
}

ROLE_TITLES = {"admin": "管理员", "editor": "登记员", "viewer": "只读"}

# 数据范围维度（行级过滤）
SCOPE_DIMS = {
    "region": "区域",
    "route": "承运商/线路",
    "zone": "库区",
    "doc_type": "单据类型",
    "waves": "波次（own=仅本人登记）",
}

# 维度 -> 事实表列（后端白名单，禁止拼接任意列名）
DIMENSIONS = {
    "route": "承运商/线路",
    "zone": "库区",
    "region": "区域",
    "doc_type": "单据类型",
    "dealer": "经销商",
    "wave": "波次",
    "carrier_tms": "运输承运商",
    "status": "发运状态",
    "hour": "小时",
    "date": "日期",
}

METRICS = {
    "rows": "明细行数",
    "groups": "订单组数",
    "amount": "金额(元)",
    "qty": "数量",
    "picked": "已拣行数",
    "checked": "已复核行数",
    "out": "已出库行数",
    "out_rate": "出库完成率",
}


def preset_codes(role):
    return sorted(PRESETS.get(role or "viewer", PRESETS["viewer"]))
