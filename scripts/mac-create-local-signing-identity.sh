#!/usr/bin/env bash
# 同频：为本机 Mac 打包创建一个“稳定的”自签名代码签名证书（只需运行一次）。
#
# 为什么需要：
#   目前的 Mac 包是 ad-hoc 签名（没有固定身份）。每次重新打包/更新，macOS 都把
#   同频当成“另一个程序”：钥匙串里“同频 Safe Storage”的授权和“辅助功能/录屏”
#   等隐私权限都要重新确认，拒绝或错过提示时，已保存的登录状态和记住的密码就读
#   不出来，只能重新登录。用同一张证书签名后，应用身份在更新前后保持不变。
#
# 这个脚本只做三件事（均只作用于当前用户）：
#   1. 用系统自带的 /usr/bin/openssl 生成一张仅用于“代码签名”的自签名证书；
#   2. 导入到当前用户的“登录”钥匙串（不碰系统钥匙串）；
#   3. 在当前用户的信任设置里把它标记为“代码签名：始终信任”（仅 codeSign 用途，
#      不信任 SSL/邮件等其他用途；macOS 会弹窗要求输入本机登录密码确认）。
#
# 不会：使用 sudo、修改系统钥匙串或全局信任设置、上传任何内容、自动运行。
# 可重复运行：证书已存在且可用时直接退出；已存在但未信任时只补做第 3 步。
#
# 用法（在 Mac 的“终端”里，项目根目录下）：
#   bash scripts/mac-create-local-signing-identity.sh               # 默认名称
#   bash scripts/mac-create-local-signing-identity.sh "My Tongpin Signing"   # 自定义名称（仅字母/数字/空格/._-）
# 之后打包：
#   TONGPIN_MAC_SIGN_IDENTITY="Tongpin Local Code Signing" npm run dist:mac
#
# 撤销：打开“钥匙串访问” → 登录 → 我的证书，删除同名证书（会一并删除私钥和信任设置）。

set -euo pipefail

NAME="${1:-${TONGPIN_MAC_SIGN_IDENTITY:-Tongpin Local Code Signing}}"
OPENSSL="/usr/bin/openssl"   # macOS 自带（LibreSSL），生成的 .p12 能被 security 正确导入
DAYS=3650

fail() { printf '✗ %s\n' "$1" >&2; exit 1; }
info() { printf '• %s\n' "$1"; }

[[ "$(uname -s)" == "Darwin" ]] || fail "只能在 macOS 上运行。"
[[ "${EUID:-$(id -u)}" -ne 0 ]] || fail "请不要用 sudo 运行：证书必须放在你自己的登录钥匙串里。"
command -v security >/dev/null 2>&1 || fail "找不到 macOS 的 security 命令。"
[[ -x "$OPENSSL" ]] || fail "找不到 $OPENSSL。"
NAME_PATTERN='^[A-Za-z0-9][A-Za-z0-9 ._-]{2,63}$'
[[ "$NAME" =~ $NAME_PATTERN ]] || fail "证书名称只能包含字母、数字、空格和 ._-（3–64 个字符）。"
case "$NAME" in
  "Developer ID"*|"Apple "*|"Mac Developer"*|"3rd Party Mac Developer"*)
    fail "请不要使用 Apple 正式证书的名称前缀。" ;;
esac

KEYCHAIN="$(security login-keychain 2>/dev/null | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//')"
[[ -n "$KEYCHAIN" && -f "$KEYCHAIN" ]] || KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
[[ -f "$KEYCHAIN" ]] || fail "找不到当前用户的登录钥匙串：$KEYCHAIN"
case "$KEYCHAIN" in
  /Library/*|/System/*) fail "拒绝操作系统钥匙串：$KEYCHAIN" ;;
esac

identity_is_valid() {
  security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | grep -F "\"$NAME\"" >/dev/null
}
identity_exists() {
  security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -F "\"$NAME\"" >/dev/null
}

print_next_steps() {
  local sha1
  sha1="$(security find-certificate -c "$NAME" -Z "$KEYCHAIN" 2>/dev/null | awk '/SHA-1/ {print $NF; exit}')"
  cat <<EOF

✓ 本机代码签名身份已就绪：「$NAME」${sha1:+（SHA-1 $sha1）}
  钥匙串：$KEYCHAIN

下一步（每次打包都带上这个环境变量）：
  TONGPIN_MAC_SIGN_IDENTITY="$NAME" npm run dist:mac

第一次用它打包时，macOS 可能询问 codesign 能否使用这张证书的私钥：请选“始终允许”。
第一次打开用它签名的同频时，钥匙串会询问能否读取“同频 Safe Storage”：输入本机登录
密码后选“始终允许”；“辅助功能/录屏”权限也需要重新勾选一次。之后更新不再更换应用身份。
详见 docs/MACOS.md 的“本机稳定签名”。
EOF
}

if identity_is_valid; then
  info "已存在可用的代码签名证书「$NAME」，无需重复创建。"
  print_next_steps
  exit 0
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tongpin-signing.XXXXXX")"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT
chmod 700 "$TMP_DIR"
umask 077

trust_for_code_signing() {
  local certificate="$1"
  info "为「$NAME」添加“代码签名：始终信任”（仅当前用户、仅代码签名用途）。macOS 会弹窗要求输入登录密码。"
  if ! security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$certificate"; then
    fail "未能写入信任设置。也可以在“钥匙串访问”中双击证书 → 信任 → 代码签名：始终信任，然后重新运行本脚本。"
  fi
}

if identity_exists; then
  info "证书「$NAME」已存在但尚未被信任用于代码签名。"
  security find-certificate -c "$NAME" -p "$KEYCHAIN" > "$TMP_DIR/existing-certificate.pem"
  trust_for_code_signing "$TMP_DIR/existing-certificate.pem"
elif security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  fail "钥匙串里已有名为「$NAME」但缺少私钥的证书。请在“钥匙串访问”中删除它，或换一个名称再运行。"
else
  info "生成自签名代码签名证书「$NAME」（有效期 $DAYS 天，私钥只在本机）。"
  cat > "$TMP_DIR/openssl.cnf" <<EOF
[ req ]
distinguished_name = subject
prompt = no
[ subject ]
CN = $NAME
[ codesign ]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF
  "$OPENSSL" req -x509 -newkey rsa:2048 -sha256 -days "$DAYS" -nodes \
    -config "$TMP_DIR/openssl.cnf" -extensions codesign \
    -keyout "$TMP_DIR/private-key.pem" -out "$TMP_DIR/certificate.pem" >/dev/null 2>&1 \
    || fail "生成证书失败。"
  # 一次性随机口令，仅用于把 .p12 交给 security 导入；临时文件退出时删除。
  TONGPIN_P12_PASS="$("$OPENSSL" rand -base64 24)"
  export TONGPIN_P12_PASS
  "$OPENSSL" pkcs12 -export -name "$NAME" \
    -inkey "$TMP_DIR/private-key.pem" -in "$TMP_DIR/certificate.pem" \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
    -passout env:TONGPIN_P12_PASS -out "$TMP_DIR/identity.p12" >/dev/null 2>&1 \
    || fail "打包 .p12 失败。"
  info "导入到登录钥匙串（仅允许 /usr/bin/codesign 直接使用该私钥）。"
  security import "$TMP_DIR/identity.p12" -k "$KEYCHAIN" -f pkcs12 \
    -P "$TONGPIN_P12_PASS" -T /usr/bin/codesign >/dev/null \
    || fail "导入登录钥匙串失败（钥匙串可能已锁定：请先解锁后重试）。"
  unset TONGPIN_P12_PASS
  trust_for_code_signing "$TMP_DIR/certificate.pem"
fi

identity_is_valid || fail "证书已导入，但 macOS 仍未把它列为可用的代码签名身份。请在“钥匙串访问”中确认它的“代码签名”信任为“始终信任”。"
print_next_steps
