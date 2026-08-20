// AizenAssistant launcher（受管安装的启动入口）。
//
// 职责：读取 install.json 的 current 版本目录 → 启动 versions/<current>/ 下的真实可执行文件，
// 并透传标准输入输出与退出码；按"默认参数表"注入默认参数（用户已显式传入的 flag 不注入）。
//
// 设计约束：
// - 只服务受管安装（install.json 存在且含 current）；便携模式不经过 launcher，直接运行真实可执行文件。
// - 对主程序 CLI 语义零认知：不辨认主程序子命令，注入规则只看"用户是否已传入同名 flag"。
// - POSIX 上用 exec 替换自身进程（不留双进程）；Windows 无 exec，等待子进程并透传退出码。
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// 安装记录：launcher 仅消费 current 字段。
type installRecord struct {
	Current string `json:"current"`
}

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

// readInstallRecord 读取 install.json 并校验 current 字段；失败时返回用户可读的错误。
func readInstallRecord(recordPath string) (*installRecord, error) {
	data, err := os.ReadFile(recordPath)
	if err != nil {
		return nil, fmt.Errorf("无法读取安装记录 %s：%w", recordPath, err)
	}
	var record installRecord
	if err := json.Unmarshal(data, &record); err != nil || record.Current == "" {
		return nil, errors.New("安装记录缺少 current 字段，请重新安装")
	}
	return &record, nil
}

func main() {
	launcherPath, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "无法确定 launcher 自身路径：%v\n", err)
		os.Exit(1)
	}
	root := installRoot(launcherPath)
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
	args := mergeDefaults(defaultArgs(root), os.Args[1:])
	runTarget(exe, args)
}
