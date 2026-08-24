#!/usr/bin/env bash
# AizenAssistant 安装脚本（macOS / Linux）
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/Spring500/aizen-assistant/main/install.sh | bash
#   bash install.sh 0.1.0        # 指定历史版本（默认安装最新版）
#   GITHUB_TOKEN=xxx bash install.sh --version 0.2.0-beta.1   # 安装预发布版（Draft，需 push 权限 token）
#
# 行为：检测平台 → 下载压缩包 → SHA256 校验 → 解压到 ~/.aizen/bin → 幂等配置 PATH → 写 install.json。
# 只修改用户级位置，不需要 sudo。重复执行安全（幂等）。
set -euo pipefail

REPOSITORY="Spring500/aizen-assistant"
# 发布网页、API 与下载基地址；可通过 --latest-url / --api-url / --download-url 覆盖测试或镜像入口。
RELEASE_LATEST="https://github.com/${REPOSITORY}/releases/latest"
RELEASE_API="https://api.github.com/repos/${REPOSITORY}"
RELEASE_DOWNLOAD="https://github.com/${REPOSITORY}/releases/download"
CUSTOM_API=0
# 首版已发布平台（与 release 矩阵保持一致；win/linux arm64 待验证后增补，Intel Mac 暂不支持）。
SUPPORTED_PLATFORMS="linux-x64 darwin-arm64 windows-x64"
HOME_DIR="${HOME:-}"
CONFIG_DIR="$HOME_DIR/.aizen"
INSTALL_DIR="$CONFIG_DIR/bin"
VERSIONS_DIR="$CONFIG_DIR/versions"
DATA_DIR="$CONFIG_DIR/data"

REQUESTED_VERSION=""
SKIP_PATH=0
CUSTOM_INSTALL_DIR=0
# GitHub token（环境变量或 --token）：仅预发布测试需要——Draft Release 对匿名请求不可见，
# 资产须经鉴权资产 API 下载；正式安装路径不使用 token，行为不变。
TOKEN="${GITHUB_TOKEN:-}"

# 校验选项值存在且非另一选项（避免 --version --skip-path 把 --skip-path 误当版本号）。
require_value() {
  if [ -z "$2" ] || [ "${2#--}" != "$2" ]; then
    echo "错误：$1 必须提供值" >&2
    exit 1
  fi
}

# 解析参数：--version / --install-dir / --latest-url / --api-url / --download-url / --token / --skip-path；兼容位置参数形式传入版本号。
parse_arguments() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) require_value "$1" "${2:-}"; REQUESTED_VERSION="$2"; shift 2 ;;
      --install-dir) require_value "$1" "${2:-}"; INSTALL_DIR="$2"; CONFIG_DIR="$(dirname "$INSTALL_DIR")"; VERSIONS_DIR="$CONFIG_DIR/versions"; DATA_DIR="$CONFIG_DIR/data"; CUSTOM_INSTALL_DIR=1; shift 2 ;;
      --latest-url) require_value "$1" "${2:-}"; RELEASE_LATEST="$2"; shift 2 ;;
      --api-url) require_value "$1" "${2:-}"; RELEASE_API="$2"; CUSTOM_API=1; shift 2 ;;
      --download-url) require_value "$1" "${2:-}"; RELEASE_DOWNLOAD="$2"; shift 2 ;;
      --token) require_value "$1" "${2:-}"; TOKEN="$2"; shift 2 ;;
      --skip-path) SKIP_PATH=1; shift ;;
      -h | --help) echo "用法：install.sh [版本号] [--version <v>] [--install-dir <目录>] [--latest-url <url>] [--api-url <url>] [--download-url <url>] [--token <gh-token>] [--skip-path]"; exit 0 ;;
      *) if [ -z "$REQUESTED_VERSION" ]; then REQUESTED_VERSION="$1"; shift; else echo "未知参数：$1" >&2; exit 1; fi ;;
    esac
  done
}

parse_arguments "$@"

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

# 查询最新正式版本号（去掉 v 前缀）。默认通过 GitHub Releases 网页重定向取最终 tag，
# 避免匿名 REST API 限流；显式 --api-url 时保留 JSON API 兼容路径。
fetch_latest_version() {
  local tag final_url
  if [ "$CUSTOM_API" -eq 1 ]; then
    tag="$({ curl -fsSL "${RELEASE_API}/releases/latest" || true; } |
      grep -o '"tag_name"[[:space:]]*:[[:space:]]*"v[^"]*"' |
      head -1 |
      sed 's/.*"\(v[^"]*\)"/\1/' || true)"
  else
    final_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$RELEASE_LATEST" || true)"
    case "$final_url" in
      */"${REPOSITORY}"/releases/tag/v*) tag="${final_url##*/}" ;;
      *) tag="" ;;
    esac
  fi
  case "$tag" in
    v?*) printf '%s\n' "${tag#v}" ;;
  esac
}

# 计算文件的 SHA256（兼容 macOS 的 shasum 与 Linux 的 sha256sum）。
file_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

# 从 releases 列表 JSON 中取指定 tag 的资产 id（token 模式；Draft 仅在鉴权列表中可见）。
# 嵌套 JSON 用 grep/sed 解析不可靠（body/uploader 等字段含干扰 id），依赖 python3 或 jq 之一；
# 仅预发布测试路径需要，匿名正式安装不经过此函数、保持零额外依赖。
asset_id_from_releases() {
  local json_file="$1" tag="$2" asset_name="$3"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$json_file" "$tag" "$asset_name" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    releases = json.load(f)
for release in releases:
    if release.get("tag_name") == sys.argv[2]:
        for asset in release.get("assets", []):
            if asset.get("name") == sys.argv[3]:
                print(asset["id"])
                sys.exit(0)
sys.exit(1)
PY
  elif command -v jq >/dev/null 2>&1; then
    jq -re --arg tag "$tag" --arg name "$asset_name" \
      '[.[] | select(.tag_name == $tag) | .assets[] | select(.name == $name) | .id][0] // empty' "$json_file"
  else
    echo "错误：token 模式需要 python3 或 jq 解析 API 响应（仅预发布测试需要）" >&2
    return 1
  fi
}

# token 模式下载单个资产：先从鉴权 releases 列表解析资产 id，再经资产 API 以 octet-stream 下载
#（Draft 资产没有可匿名访问的 browser_download_url，只能走这条通道）。
download_asset_with_token() {
  local releases_json="$1" tag="$2" asset_name="$3" dest="$4"
  local asset_id
  asset_id="$(asset_id_from_releases "$releases_json" "$tag" "$asset_name")"
  if [ -z "$asset_id" ]; then
    echo "错误：发布 $tag 中找不到资产 $asset_name（确认 tag 存在且 token 有仓库读权限）" >&2
    return 1
  fi
  curl -fL -H "Authorization: Bearer $TOKEN" -H "Accept: application/octet-stream" \
    "${RELEASE_API}/releases/assets/${asset_id}" -o "$dest"
}

# 下载、校验并解压指定版本，把可执行文件放入安装目录；输出实际安装版本号。
# 注意：调用方用命令替换捕获本函数的 stdout 作为返回值，因此函数内一切
# 人类可读输出必须发往 stderr（>&2），stdout 只允许最后一行版本号。
download_and_install() {
  local version="$1" platform="$2"
  local base_url="${RELEASE_DOWNLOAD}/v${version}"
  local zip_name="aizen-assistant-${version}-${platform}.zip"
  local tmp_dir extracted_dir expected actual installed_version
  tmp_dir="$(mktemp -d)"
  # 无论成功失败都清理临时目录（覆盖中途 exit 的情况）。
  trap "rm -rf '$tmp_dir'" EXIT

  echo "下载 ${zip_name} ..." >&2
  if [ -n "$TOKEN" ]; then
    # token 模式：经鉴权 API 下载（可见范围含 Draft，供预发布测试；后续校验/解压/落位与匿名路径完全一致）
    local releases_json="$tmp_dir/releases.json"
    curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
      "${RELEASE_API}/releases?per_page=100" -o "$releases_json"
    download_asset_with_token "$releases_json" "v${version}" "$zip_name" "$tmp_dir/$zip_name"
    download_asset_with_token "$releases_json" "v${version}" "SHA256SUMS" "$tmp_dir/SHA256SUMS"
  else
    curl -fL "${base_url}/${zip_name}" -o "$tmp_dir/$zip_name"
    curl -fL "${base_url}/SHA256SUMS" -o "$tmp_dir/SHA256SUMS"
  fi

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
  if [ ! -f "$extracted_dir/launcher" ]; then
    echo "错误：压缩包内未找到 launcher（旧版发布包不含 launcher，请安装更新的版本）" >&2
    exit 1
  fi

  # 旧布局迁移必须在包内容验证完整（exe 与 launcher 都存在）之后才执行：
  # 迁移会移走 bin/ 下的旧可执行文件，若先迁移后验包失败（如安装的目标版本
  # 是不含 launcher 的旧发布包），会留下 "bin/ 无启动入口" 的坏中间态，
  # 且因旧布局检测不再命中而无法重跑自愈。
  if needs_legacy_migration; then
    echo "检测到旧版单文件布局，正在迁移..." >&2
    migrate_legacy_layout
  fi

  # 真实可执行文件放入 versions/v<版本>/，bin/ 下放置发布包内的 launcher（多版本布局：运行中的实例不被替换）
  version_dir="$VERSIONS_DIR/v$version"
  mkdir -p "$version_dir"
  cp -f "$extracted_dir/aizen-assistant" "$version_dir/aizen-assistant"
  chmod +x "$version_dir/aizen-assistant"
  mkdir -p "$INSTALL_DIR"
  cp -f "$extracted_dir/launcher" "$INSTALL_DIR/aizen-assistant"
  chmod +x "$INSTALL_DIR/aizen-assistant"
  # 数据目录固定于安装根，安装时创建保证就绪
  mkdir -p "$DATA_DIR"

  if [ -f "$extracted_dir/version" ]; then
    installed_version="$(tr -d '[:space:]' < "$extracted_dir/version")"
  fi
  [ -n "$installed_version" ] || installed_version="$version"
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
  "platform": "$platform",
  "current": "v$version"
}
EOF
}

# 向指定 shell 配置文件幂等追加 PATH；剩余参数为需检测的已存在形式（默认安装的字面、~ 与绝对路径三种写法）。
append_path_line() {
  local file="$1" line="$2"
  shift 2
  if [ -f "$file" ]; then
    local p
    for p in "$@"; do
      if grep -qF "$p" "$file"; then
        echo "PATH 已配置：$file"
        return
      fi
    done
  fi
  printf '\n# AizenAssistant\n%s\n' "$line" >> "$file"
  echo "已追加 PATH 到 $file"
}

# 检测旧单文件布局：bin/ 下是可执行文件且 install.json 无 current 字段（多版本布局才有 current）。
needs_legacy_migration() {
  [ -f "$INSTALL_DIR/aizen-assistant" ] || return 1
  if [ -f "$CONFIG_DIR/install.json" ] && grep -q '"current"' "$CONFIG_DIR/install.json" 2>/dev/null; then
    return 1
  fi
  return 0
}

# 从旧单文件布局迁移到多版本布局：旧 exe → versions/v<旧版本>/，bin/.aizen → data/（bin/ 随后由下载流程放置 launcher）。
# 本函数在 download_and_install 内部调用（包验证之后），而该函数的 stdout 是返回值通道，
# 因此本函数的人类可读输出必须发往 stderr。
migrate_legacy_layout() {
  local old_version="legacy"
  if [ -f "$CONFIG_DIR/install.json" ]; then
    old_version="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG_DIR/install.json" | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/')"
    [ -n "$old_version" ] || old_version="legacy"
  fi
  local version_dir="$VERSIONS_DIR/v$old_version"
  mkdir -p "$version_dir"
  mv -f "$INSTALL_DIR/aizen-assistant" "$version_dir/aizen-assistant"
  chmod +x "$version_dir/aizen-assistant"
  if [ -d "$INSTALL_DIR/.aizen" ]; then
    mkdir -p "$DATA_DIR"
    # 子 shell 内开启 dotglob：bash 默认 glob 不匹配点开头文件（如会话锁 .sessions），
    # 不开启会漏迁移隐藏文件并被随后的 rm -rf 删除；nullglob 避免空目录时 glob 字面传递。
    (shopt -s dotglob nullglob; mv -f "$INSTALL_DIR/.aizen"/* "$DATA_DIR"/ 2>/dev/null || true)
    rm -rf "$INSTALL_DIR/.aizen"
  fi
  echo "旧版布局已迁移：versions/v$old_version 与 $DATA_DIR" >&2
}

# 按当前 shell 配置 PATH（bash/zsh/fish），幂等。
# 默认安装写 $HOME/.aizen/bin 字面（由 shell 在 source 时展开，用户目录迁移后 PATH 仍有效）；
# 幂等检测同时匹配字面、~ 与绝对路径三种写法。bash 同时写 .bashrc 与 .bash_profile，
# 覆盖 macOS 登录 shell 不读 .bashrc 的场景。
configure_path() {
  local shell_name path_entry
  local -a patterns
  shell_name="$(basename "${SHELL:-}")"
  if [ "$CUSTOM_INSTALL_DIR" -eq 1 ]; then
    path_entry="$INSTALL_DIR"
    patterns=("$INSTALL_DIR")
  else
    path_entry='$HOME/.aizen/bin'
    patterns=('$HOME/.aizen/bin' '~/.aizen/bin' "$CONFIG_DIR/bin")
  fi
  case "$shell_name" in
    zsh) append_path_line "$HOME_DIR/.zshrc" "export PATH=\"$path_entry:\$PATH\"" "${patterns[@]}" ;;
    fish)
      local fish_file="$HOME_DIR/.config/fish/config.fish"
      mkdir -p "$(dirname "$fish_file")"
      append_path_line "$fish_file" "fish_add_path $path_entry" "${patterns[@]}"
      ;;
    *)
      append_path_line "$HOME_DIR/.bashrc" "export PATH=\"$path_entry:\$PATH\"" "${patterns[@]}"
      append_path_line "$HOME_DIR/.bash_profile" "export PATH=\"$path_entry:\$PATH\"" "${patterns[@]}"
      ;;
  esac
}

main() {
  local platform version installed_version
  if [ -z "$HOME_DIR" ]; then
    echo "错误：无法确定用户主目录（HOME 未设置）" >&2
    exit 1
  fi
  platform="$(detect_platform)"
  if ! echo "$SUPPORTED_PLATFORMS" | grep -qw "$platform"; then
    echo "错误：当前平台（${platform}）暂未提供官方安装包（支持：${SUPPORTED_PLATFORMS}）" >&2
    exit 1
  fi

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
  # 旧布局迁移在 download_and_install 内部、包内容验证之后执行（见其注释），此处不再前置调用
  installed_version="$(download_and_install "$version" "$platform")"
  write_install_record "$installed_version" "$platform"
  if [ "$SKIP_PATH" -ne 1 ]; then
    configure_path
  fi

  cat <<EOF

安装完成：AizenAssistant v${installed_version}（${platform}）
安装位置：$INSTALL_DIR
数据目录：$DATA_DIR（固定于安装根，升级不迁移）

请重新打开终端后运行：
  aizen-assistant
更新：aizen-assistant update
卸载：aizen-assistant uninstall
EOF
}

main "$@"
