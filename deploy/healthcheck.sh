#!/usr/bin/env bash
# 单量与作业进度看板：健康检查（由 cron 每 5 分钟执行）
#
# 判定：curl /api/health 失败即计一次失败。
# 告警：连续失败达到 3 次写 /var/log/work-atlas-alert.log；
#       之后每小时（每 12 次）追加一条，避免刷屏；恢复时补一条恢复记录。
# 状态：连续失败次数保存在 /var/lib/work-atlas/health-fail-count。

set -u

PORT="${PORT:-18082}"
STATE_DIR=/var/lib/work-atlas
STATE_FILE="$STATE_DIR/health-fail-count"
ALERT_LOG=/var/log/work-atlas-alert.log
THRESHOLD=3

mkdir -p "$STATE_DIR"
count=0
if [ -f "$STATE_FILE" ]; then
    count=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
fi
case "$count" in
    ''|*[!0-9]*) count=0 ;;
esac

if curl -fsS --max-time 10 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    if [ "$count" -ge "$THRESHOLD" ]; then
        printf '%s 恢复：/api/health 已可访问（此前连续失败 %s 次）\n' \
            "$(date '+%F %T')" "$count" >> "$ALERT_LOG"
    fi
    echo 0 > "$STATE_FILE"
    exit 0
fi

count=$((count + 1))
echo "$count" > "$STATE_FILE"

if [ "$count" -eq "$THRESHOLD" ] || { [ "$count" -gt "$THRESHOLD" ] && [ $(( (count - THRESHOLD) % 12 )) -eq 0 ]; }; then
    {
        printf '%s 告警：/api/health 连续失败 %s 次\n' "$(date '+%F %T')" "$count"
        printf '  systemd: %s\n' "$(systemctl is-active work-atlas 2>/dev/null)"
        printf '  监听: %s\n' "$(ss -lnt 2>/dev/null | grep -c ":$PORT ")"
        printf '  最近日志:\n'
        tail -5 /var/log/work-atlas.log 2>/dev/null | sed 's/^/    /'
    } >> "$ALERT_LOG"
fi

exit 1
