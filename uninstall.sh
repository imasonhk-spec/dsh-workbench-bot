#!/usr/bin/env bash
# DSH 插件卸载器
set -euo pipefail

PKG_NAME="dsh-workbench-bot"
PKG_VERSION="0.3.0"
PLUGIN_DIR="@local/dsh-workbench-bot"
SERVICES=""
# 额外随包安装的插件（如 ds-bot）。卸载必须一并处理，
# 否则会留下孤儿包，且 profile 的 bundles 里仍声明着它 → 下次重装
# Loader 报 repeated id，或加载到一份没有宿主的空壳。
EXTRA_BUNDLES="ds-bot"

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/web"
USERS_DIR="$DSH_HOME/multi-user/users"

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

echo "==> 卸载 $PKG_NAME $PKG_VERSION"

remove_from(){
  local p="$1" label="$2"
  local nm="$p/node_modules"
  [ -d "$nm" ] || return 0
  for d in "$PLUGIN_DIR" $EXTRA_BUNDLES; do
    [ -n "$d" ] || continue
    bn=$(echo "$d" | sed 's|^@local/||; s|.*/||')
    if echo "$d" | grep -q '^@local/'; then
      rm -rf "$nm/@local/$bn" && echo "  ✓ $label: @local/$bn"
    else
      rm -rf "$nm/$bn" && echo "  ✓ $label: $bn"
    fi
  done
  # 从 bundles 声明里摘掉，避免残留声明指向已删目录（loader 会刷
  # cannot resolve profile bundle，且面板全空白）
  unregister_bundles "$p" "$label"
}

unregister_bundles(){
  local prof="$1" label="$2"
  local pj="$prof/package.json"
  [ -f "$pj" ] || return 0
  command -v python3 >/dev/null || return 0
  python3 - "$pj" "$PLUGIN_DIR" $EXTRA_BUNDLES <<'PYEOF'
import json, os, sys
pj, rm = sys.argv[1], [x for x in sys.argv[2:] if x]
try:
    d = json.load(open(pj, encoding="utf-8"))
except Exception:
    sys.exit(0)
prof = (d.get("dsh") or {}).get("profile") or {}
b = prof.get("bundles") or []
new = [x for x in b if x not in rm]
if new != b:
    prof["bundles"] = new
    tmp = pj + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    os.replace(tmp, pj)
    print("    bundle 声明已摘除: %s" % " ".join(x for x in rm if x in b))
PYEOF
}

remove_from "$PROFILE_DIR" "宿主"
if [ -d "$USERS_DIR" ]; then
  for u in "$USERS_DIR"/*/; do
    remove_from "$u/home/profiles/web" "$(basename "$u")"
  done
fi

for s in $SERVICES; do
  if systemctl list-unit-files | grep -q "^$s.service"; then
    $SUDO systemctl stop "$s" 2>/dev/null || true
    $SUDO systemctl disable "$s" 2>/dev/null || true
    $SUDO rm -f "/etc/systemd/system/$s.service"
    $SUDO rm -rf "/etc/systemd/system/$s.service.d"
    echo "  ✓ 服务已移除: $s"
  fi
done
$SUDO systemctl daemon-reload

echo "==> 完成（venv 与数据目录保留，如需清理请手动处理）"
