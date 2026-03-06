#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/turbogeek/vscode/charts"
cd "$ROOT"

echo "==> Charts cleanup in: $ROOT"
echo

echo "==> 1) Removing script-made backups (*.bak_*)"
find "$ROOT" -type f -name "*.bak_*" -print -delete || true

echo
echo "==> 2) Removing common fix/upgrade scripts (project root only)"
# adjust this list if you want to keep any
PATTERNS=(
  "fix_*.sh"
  "pro_*.sh"
  "*upgrade*.sh"
  "*restore*.sh"
  "*force*drop*.sh"
  "build_engine.sh"
  "build_v2_engine.sh"
  "build_terminal_all.sh"
  "upgrade_terminal_v3.sh"
  "upgrade_terminal_v4.sh"
)

for pat in "${PATTERNS[@]}"; do
  # only root-level files
  find "$ROOT" -maxdepth 1 -type f -name "$pat" -print -delete || true
done

echo
echo "==> 3) Removing old restore snapshots (_restore_bak_*)"
# comment out this block if you want to keep snapshots
find "$ROOT" -maxdepth 1 -type d -name "_restore_bak_*" -print -exec rm -rf {} \; || true

echo
echo "==> 4) Removing known dead artifacts (optional)"
# Remove old index backups if you want
find "$ROOT" -maxdepth 1 -type f -name "index_backup_*.html" -print -delete || true
find "$ROOT" -maxdepth 1 -type d -name "src_backup_*" -print -exec rm -rf {} \; || true

echo
echo "==> Done."
echo "Remaining root files:"
ls -la "$ROOT" | sed -n '1,120p'
