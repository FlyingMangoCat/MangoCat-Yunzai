#!/usr/bin/env bash
# scripts/ci-audit.sh — 平台无关的插件审计入口
#
# 用法：
#   bash scripts/ci-audit.sh                  # 审改动（默认相对 origin/master）
#   BASE_REF=origin/main bash scripts/ci-audit.sh
#   BASE_REF=HEAD~1 bash scripts/ci-audit.sh  # 本地审上一个提交
#   AUDIT_ALL=1 bash scripts/ci-audit.sh      # 全量审所有插件
#   INIT_NEW=1 bash scripts/ci-audit.sh       # 新插件先建基线再继续
#
# 退出码：0 通过；1 有问题或缺基线；2 环境/用法错误
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

BASE_REF="${BASE_REF:-${GITHUB_BASE_REF:-origin/master}}"
AUDIT_ALL="${AUDIT_ALL:-0}"
INIT_NEW="${INIT_NEW:-0}"
BASELINE="tools/plugin-audit-baseline.json"
EXCLUDE="data"

if [ ! -f "$BASELINE" ]; then
  echo "[ci-audit] 缺少基线文件 $BASELINE" >&2
  echo "[ci-audit] 先跑：node tools/plugin-audit.mjs plugins/<name> --ratchet" >&2
  exit 2
fi

list_all_plugins() {
  for d in plugins/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    [ "$name" = "$EXCLUDE" ] && continue
    echo "$name"
  done
}

resolve_base() {
  if git rev-parse --verify -q "$1" >/dev/null 2>&1; then echo "$1"; return 0; fi
  if git rev-parse --verify -q "origin/main" >/dev/null 2>&1; then echo "origin/main"; return 0; fi
  if git rev-parse --verify -q "HEAD~1" >/dev/null 2>&1; then echo "HEAD~1"; return 0; fi
  return 1
}

collect_changed() {
  {
    git diff --name-only "$1...HEAD" -- plugins 2>/dev/null || true
    git diff --name-only -- plugins 2>/dev/null || true
    git diff --cached --name-only -- plugins 2>/dev/null || true
    git ls-files --others --exclude-standard -- plugins 2>/dev/null || true
  } | awk -F/ 'NF>2 {print $2}' | sort -u
}

if [ "$AUDIT_ALL" = "1" ]; then
  DIRS="$(list_all_plugins)"
  echo "[ci-audit] 全量模式"
elif BASE="$(resolve_base "$BASE_REF")"; then
  DIRS="$(collect_changed "$BASE")"
  echo "[ci-audit] 改动模式：相对 $BASE"
else
  echo "[ci-audit] 无法确定基线 ref，退回全量" >&2
  DIRS="$(list_all_plugins)"
fi

DIRS="$(printf '%s\n' "$DIRS" | grep -v '^$' || true)"

if [ -z "$DIRS" ]; then
  echo "[ci-audit] 没有插件改动，跑 example 冒烟"
  node tools/plugin-audit.mjs plugins/example --no-md --fail-on critical
  exit $?
fi

echo "[ci-audit] 待审：$(printf '%s ' $DIRS)"

MISSING="$(DIRS="$DIRS" BASELINE="$BASELINE" node -e '
const fs = require("fs");
const db = JSON.parse(fs.readFileSync(process.env.BASELINE, "utf8"));
const dirs = (process.env.DIRS || "").split(/\s+/).filter(Boolean);
process.stdout.write(dirs.filter((d) => !(db.plugins || {})[d]).join(" "));
')" || { echo "[ci-audit] 读取基线失败" >&2; exit 2; }

if [ -n "$MISSING" ]; then
  if [ "$INIT_NEW" = "1" ]; then
    echo "[ci-audit] 为新插件建基线：$MISSING"
    for p in $MISSING; do
      node tools/plugin-audit.mjs "plugins/$p" --ratchet --no-md || exit 1
    done
  else
    echo "[ci-audit] 以下插件没有基线：$MISSING" >&2
    echo "[ci-audit] 先本地跑 node tools/plugin-audit.mjs plugins/<name> --ratchet，确认报告后提交基线" >&2
    exit 1
  fi
fi

FAILED=0
for p in $DIRS; do
  [ -d "plugins/$p" ] || continue
  echo ""
  echo "========== plugins/$p =========="
  if ! node tools/plugin-audit.mjs "plugins/$p" --ratchet --no-md --fail-on critical; then
    FAILED=1
  fi
done

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "[ci-audit] OK：全部通过"
else
  echo "[ci-audit] FAIL：有插件未通过（新增命中或 CRITICAL）" >&2
fi
exit "$FAILED"
