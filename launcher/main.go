// AizenAssistant launcher（受管安装的启动入口与安装管理器）。
//
// 职责：
//   - 启动：读 install.json 的 current → 启动 versions/<current>/ 下的真实可执行文件，
//     按"默认参数表"注入默认参数（用户已显式传入的 flag 不注入）并透传 stdio 与退出码。
//   - update：下载新版本落位 versions/、原子切换 current、自更新 launcher、GC 历史版本。
//   - uninstall：确认后回滚 PATH 并删除安装根（Windows 下自身被锁，交延迟脚本删除）。
//
// 设计约束：
//   - 只服务受管安装（install.json 存在且含 current）；便携模式不经过 launcher，直接运行真实可执行文件。
//   - 对主程序 CLI 语义零认知：update/uninstall 是 launcher 自身的子命令（不启动主程序），
//     其余参数一律透传，未来主程序新增参数/子命令无需同步更新 launcher。
//   - POSIX 上用 exec 替换自身进程（不留双进程）；Windows 无 exec，等待子进程并透传退出码。
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// installRoot 返回安装根：launcher 位于 <安装根>/bin/ 下，向上两级即为安装根。
func installRoot(launcherPath string) string {
	return filepath.Dir(filepath.Dir(launcherPath))
}

// defaultArgs 返回 launcher 注入的默认参数表；每项为 {flag, 值...}。
// 将来新增注入内容只需向表中加一行，合并规则（mergeDefaults）不变。
func defaultArgs(root string) [][]string {
	return [][]string{
		{"--data-dir", filepath.Join(root, "data")},
	}
}

// mergeDefaults 合并默认参数与用户参数：逐项检查默认参数的 flag（首元素），
// 用户已显式传入同名 flag 时跳过该项注入；未传入则前置注入。用户参数保持原顺序追加在后。
func mergeDefaults(defaults [][]string, userArgs []string) []string {
	given := make(map[string]bool, len(userArgs))
	for _, arg := range userArgs {
		given[arg] = true
	}
	merged := make([]string, 0, len(userArgs)+4)
	for _, def := range defaults {
		if len(def) == 0 || given[def[0]] {
			continue
		}
		merged = append(merged, def...)
	}
	return append(merged, userArgs...)
}

// executablePath 返回 versions/<current>/ 下的真实可执行文件路径（Windows 带 .exe 后缀）。
func executablePath(root, current string) string {
	name := "aizen-assistant"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(root, "versions", current, name)
}

func main() {
	launcherPath, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "无法确定 launcher 自身路径：%v\n", err)
		os.Exit(1)
	}
	root := installRoot(launcherPath)
	args := os.Args[1:]

	// update / uninstall 是 launcher 自身的子命令：操作对象是安装布局，不启动主程序
	if len(args) > 0 && args[0] == "update" {
		os.Exit(runUpdate(root, args[1:]))
	}
	if len(args) > 0 && args[0] == "uninstall" {
		os.Exit(runUninstall(root, args[1:]))
	}

	record, err := readInstallRecord(filepath.Join(root, "install.json"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	exe := executablePath(root, record.Current)
	if _, err := os.Stat(exe); err != nil {
		fmt.Fprintf(os.Stderr, "找不到可执行文件：%s，请重新安装或运行 aizen-assistant update\n", exe)
		os.Exit(1)
	}
	runTarget(exe, mergeDefaults(defaultArgs(root), args))
}
