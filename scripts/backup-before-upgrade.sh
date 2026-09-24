#!/bin/bash
# 同频 0.1.48 -> 0.1.49 升级前备份（只读复制，不删除任何数据）
# 用法：bash scripts/backup-before-upgrade.sh [备份根目录]
# 默认备份到 ~/tongpin-upgrade-backup/<时间戳>/
set -euo pipefail

BACKUP_ROOT="${1:-$HOME/tongpin-upgrade-backup}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_ROOT/$STAMP"
APP_DATA="$HOME/Library/Application Support/同频"
APP_BUNDLE="/Applications/同频.app"

mkdir -p "$DEST"

echo "=== 同频升级前备份 $STAMP ==="
echo "目标目录：$DEST"

if [ -d "$APP_DATA" ]; then
  echo "[1/2] 备份应用数据：$APP_DATA"
  cp -R "$APP_DATA" "$DEST/应用数据-同频"
else
  echo "[1/2] 跳过：未找到应用数据 $APP_DATA"
fi

if [ -d "$APP_BUNDLE" ]; then
  echo "[2/2] 备份当前应用：$APP_BUNDLE"
  cp -R "$APP_BUNDLE" "$DEST/同频.app-0.1.48"
  # 记录当前版本与签名身份，便于回滚核验
  /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null > "$DEST/原版本.txt" || echo "0.1.48" > "$DEST/原版本.txt"
  codesign -dv "$APP_BUNDLE" 2>&1 | grep -E "Signature=|Identifier=" >> "$DEST/原版本.txt" || true
else
  echo "[2/2] 跳过：未找到应用 $APP_BUNDLE"
fi

cat > "$DEST/备份清单.txt" <<EOF
备份时间：$(date '+%Y-%m-%d %H:%M:%S %z')
备份内容：
  - 应用数据：$APP_DATA
  - 应用本体：$APP_BUNDLE（0.1.48，ad-hoc 签名）
线上数据说明：
  - 后端数据存于 Cloudflare TONGPIN_CORE Durable Object，正式部署是新增版本、不删除数据；
  - 若执行 #27 真实账号迁移，需在迁移前对受影响账号做独立备份与一致性校验（见 10-升级备份与发布计划.md）。
恢复方式：
  - 回滚应用：退出新应用后，把 "$DEST/同频.app-0.1.48" 复制回 /Applications/同频.app（需系统权限）。
  - 回滚数据：把 "$DEST/应用数据-同频" 复制回 "$APP_DATA"（先退出应用）。
EOF

echo "=== 备份完成 ==="
ls -la "$DEST"
