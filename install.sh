#!/usr/bin/env bash
# AizenAssistant 安装脚本（macOS / Linux）
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/Spring500/aizen-assistant/main/install.sh | bash
#   bash install.sh 0.1.0        # 指定历史版本（默认安装最新版）
#
# 行为：检测平台 → 下载压缩包 → SHA256 校验 → 解压到 ~/.aizen/bin → 幂等配置 PATH → 写 install.json。
# 只修改用户级位置，不需要 sudo。重复执行安全（幂等）。
set -euo pipefail

REPOSITORY="Spring500/aizen-assistant"
# 发布 API 与下载基地址；可用 AIZEN_RELEASE_API / AIZEN_RELEASE_DOWNLOAD 覆盖（本地 mock 测试或自建镜像）。
RELEASE_API="${AIZEN_RELEASE_API:-https://api.github.com/repos/${REPOSITORY}}"
RELEASE_DOWNLOAD="${AIZEN_RELEASE_DOWNLOAD:-https://github.com/${REPOSITORY}/releases/download}"
HOME_DIR="${HOME:-}"
CONFIG_DIR="$HOME_DIR/.aizen"
INSTALL_DIR="$CONFIG_DIR/bin"

REQUESTED_VERSION="${1:-}"

# 环境前置检查：需要 curl 与 unzip（macOS 自带，Linux 需安装）。
for tool in curl unzip; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "错误：需要 $tool 命令（Linux 请先安装，如 apt install $tool）" >&2
    exit 1
  fi
done

# 检测当前平台的资产标识（如 linux-x64 / darwin-arm64）。
detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux)
      case "$arch" in
        x86_64 | amd64) echo "linux-x64" ;;
        aarch64 | arm64) echo "linux-arm64" ;;
        *) echo "不支持的架构：$os $arch" >&2 && exit 1 ;;
      esac
      ;;
    Darwin)
      case "$arch" in
        x86_64) echo "darwin-x64" ;;
        arm64) echo "darwin-arm64" ;;
        *) echo "不支持的架构：$os $arch" >&2 && exit 1 ;;
      esac
      ;;
    *) echo "不支持的系统：$os" >&2 && exit 1 ;;
  esac
}

# 查询最新发布版本号（去掉 v 前缀）。
fetch_latest_version() {
  curl -fsSL "${RELEASE_API}/releases/latest" |
    grep -o '"tag_name"[[:space:]]*:[[:space:]]*"v[^"]*"' |
    head -1 |
    sed 's/.*"v\([^"]*\)"/\1/'
}

# 计算文件的 SHA256（兼容 macOS 的 shasum 与 Linux 的 sha256sum）。
file_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

# 下载、校验并解压指定版本，把可执行文件放入安装目录；输出实际安装版本号。
download_and_install() {
  local version="$1" platform="$2"
  local base_url="${RELEASE_DOWNLOAD}/v${version}"
  local zip_name="aizen-assistant-${version}-${platform}.zip"
  local tmp_dir extracted_dir expected actual installed_version
  tmp_dir="$(mktemp -d)"

  echo "下载 ${zip_name} ..."
  curl -fL "${base_url}/${zip_name}" -o "$tmp_dir/$zip_name"
  curl -fL "${base_url}/SHA256SUMS" -o "$tmp_dir/SHA256SUMS"

  expected="$(grep " ${zip_name}$" "$tmp_dir/SHA256SUMS" | awk '{print $1}' | head -1 || true)"
  if [ -z "$expected" ]; then
    echo "错误：SHA256SUMS 中找不到 ${zip_name}" >&2
    exit 1
  fi
  actual="$(file_sha256 "$tmp_dir/$zip_name")"
  if [ "$expected" != "$actual" ]; then
    echo "错误：SHA256 校验失败" >&2
    exit 1
  fi

  extracted_dir="$tmp_dir/extracted"
  unzip -oq "$tmp_dir/$zip_name" -d "$extracted_dir"
  if [ ! -f "$extracted_dir/aizen-assistant" ]; then
    echo "错误：压缩包内未找到可执行文件" >&2
    exit 1
  fi
  mkdir -p "$INSTALL_DIR"
  cp -f "$extracted_dir/aizen-assistant" "$INSTALL_DIR/aizen-assistant"
  chmod +x "$INSTALL_DIR/aizen-assistant"

  installed_version="$(tr -d '[:space:]' < "$extracted_dir/version")"
  [ -n "$installed_version" ] || installed_version="$version"
  rm -rf "$tmp_dir"
  echo "$installed_version"
}

# 写安装来源记录（channel/version/platform）。
write_install_record() {
  local version="$1" platform="$2"
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_DIR/install.json" <<EOF
{
  "channel": "github",
  "version": "$version",
  "platform": "$platform"
}
EOF
}

# 向指定 shell 配置文件幂等追加 PATH。
append_path_line() {
  local file="$1" line="$2"
  if [ -f "$file" ] && grep -qF '.aizen/bin' "$file"; then
    echo "PATH 已配置：$file"
    return
  fi
  printf '\n# AizenAssistant\n%s\n' "$line" >> "$file"
  echo "已追加 PATH 到 $file"
}

# 按当前 shell 配置 PATH（bash/zsh/fish），幂等。
configure_path() {
  local shell_name
  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh) append_path_line "$HOME_DIR/.zshrc" 'export PATH="$HOME/.aizen/bin:$PATH"' ;;
    fish)
      local fish_file="$HOME_DIR/.config/fish/config.fish"
      mkdir -p "$(dirname "$fish_file")"
      append_path_line "$fish_file" 'fish_add_path $HOME/.aizen/bin'
      ;;
    *) append_path_line "$HOME_DIR/.bashrc" 'export PATH="$HOME/.aizen/bin:$PATH"' ;;
  esac
}

main() {
  local platform version installed_version
  if [ -z "$HOME_DIR" ]; then
    echo "错误：无法确定用户主目录（HOME 未设置）" >&2
    exit 1
  fi
  platform="$(detect_platform)"

  if [ -n "$REQUESTED_VERSION" ]; then
    version="${REQUESTED_VERSION#v}"
  else
    version="$(fetch_latest_version)"
    if [ -z "$version" ]; then
      echo "错误：无法获取最新版本，请检查网络或指定历史版本重试" >&2
      exit 1
    fi
  fi

  echo "安装 AizenAssistant v${version}（${platform}）"
  installed_version="$(download_and_install "$version" "$platform")"
  write_install_record "$installed_version" "$platform"
  configure_path

  cat <<EOF

安装完成：AizenAssistant v${installed_version}（${platform}）
安装位置：$INSTALL_DIR
数据目录：$INSTALL_DIR/data（随程序目录保存）

请重新打开终端后运行：
  aizen-assistant
更新：aizen-assistant update
卸载：aizen-assistant uninstall
EOF
}

main "$@"
