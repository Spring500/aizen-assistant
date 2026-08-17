// AizenAssistant launcher（受管安装的启动入口）。
//
// 职责：读取 install.json 的 current 版本目录 → 启动 versions/<current>/ 下的真实可执行文件，
// 并透传标准输入输出与退出码；仅交互模式注入 --data-dir（update / uninstall 分发子命令不使用数据目录）。
//
// 设计约束：
// - 只服务受管安装（install.json 存在且含 current）；便携模式不经过 launcher，直接运行真实可执行文件。
// - 逻辑刻意保持极简稳定：只做"定位 + 启动 + 透传"，不承担版本检查、下载、清理等职责，
//   以保证 launcher 自身几乎不需要随主程序更新。
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
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

// shouldInjectDataDir 判断是否注入 --data-dir：仅交互模式（非 update / uninstall 分发子命令）使用数据目录。
func shouldInjectDataDir(args []string) bool {
	if len(args) == 0 {
		return true
	}
	return args[0] != "update" && args[0] != "uninstall"
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
	args := os.Args[1:]
	cmdArgs := []string{exe}
	if shouldInjectDataDir(args) {
		cmdArgs = append(cmdArgs, "--data-dir", filepath.Join(root, "data"))
	}
	cmdArgs = append(cmdArgs, args...)
	cmd := exec.Command(cmdArgs[0], cmdArgs[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	// 交互模式下 Ctrl+C 由子进程（TUI）处理，launcher 忽略信号、只透传退出码。
	signal.Ignore(os.Interrupt)
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			os.Exit(exitErr.ExitCode())
		}
		fmt.Fprintf(os.Stderr, "启动失败：%v\n", err)
		os.Exit(1)
	}
}
