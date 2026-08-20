package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// installedPathLines 安装脚本写入 shell 配置的精确 PATH 行（与 install.sh 的 append_path_line 保持一致）。
// 卸载仅删除这些精确行，避免误删用户自行配置的含 .aizen/bin 子串的其他条目。
var installedPathLines = []string{
	`export PATH="$HOME/.aizen/bin:$PATH"`,
	"fish_add_path $HOME/.aizen/bin",
}

// filterInstalledPathLines 从 shell 配置行中过滤掉安装 PATH 行；
// installBinDir 为安装目录绝对路径（覆盖 --install-dir 自定义安装与手写绝对路径的条目）。
// 语义与主程序 self-uninstall.ts 的同名函数一致。
func filterInstalledPathLines(lines []string, installBinDir string) []string {
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.Contains(line, installBinDir) {
			continue
		}
		matched := false
		for _, installed := range installedPathLines {
			if strings.Contains(line, installed) {
				matched = true
				break
			}
		}
		if !matched {
			kept = append(kept, line)
		}
	}
	return kept
}

// uninstallOptions uninstall 子命令的选项。
type uninstallOptions struct {
	yes      bool // --yes：跳过确认（非交互终端必需）
	skipPath bool // --skip-path：不回滚 PATH（测试/无副作用场景）
}

// parseUninstallArgs 解析 uninstall 子命令参数；--data-dir 接受并忽略（launcher 对任意调用形态注入默认参数）。
func parseUninstallArgs(args []string) (*uninstallOptions, error) {
	opts := &uninstallOptions{}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--yes":
			opts.yes = true
		case "--skip-path":
			opts.skipPath = true
		case "--data-dir":
			i++ // 接受并忽略（含值）
		default:
			return nil, fmt.Errorf("uninstall 只接受 --yes 与 --skip-path 参数")
		}
	}
	return opts, nil
}

// confirmUninstall 交互确认卸载；非交互终端必须显式 --yes。
func confirmUninstall(skipConfirmation bool) bool {
	if skipConfirmation {
		return true
	}
	stat, err := os.Stdin.Stat()
	if err != nil || (stat.Mode()&os.ModeCharDevice) == 0 {
		fmt.Fprintln(os.Stderr, "非交互终端下卸载需要显式确认：aizen-assistant uninstall --yes")
		return false
	}
	fmt.Print("确认卸载？将删除 ~/.aizen 目录（含全部数据）并回滚 PATH [y/N] ")
	reader := bufio.NewReader(os.Stdin)
	answer, _ := reader.ReadString('\n')
	return strings.EqualFold(strings.TrimSpace(answer), "y")
}

// removeShellPathEntries 从 bash/zsh/fish 配置中移除安装目录相关的 PATH 行（幂等重写）。
// 覆盖 install.sh 的 bash 分支写入的 .bashrc 与 .bash_profile（macOS 登录 shell 读 .bash_profile）。
func removeShellPathEntries(home, root string) {
	installBinDir := filepath.Join(root, "bin")
	candidates := []string{
		filepath.Join(home, ".bashrc"),
		filepath.Join(home, ".bash_profile"),
		filepath.Join(home, ".zshrc"),
		filepath.Join(home, ".config", "fish", "config.fish"),
	}
	for _, file := range candidates {
		data, err := os.ReadFile(file)
		if err != nil {
			if !os.IsNotExist(err) {
				fmt.Fprintf(os.Stderr, "无法读取 %s：%v\n", file, err)
			}
			continue
		}
		lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
		kept := filterInstalledPathLines(lines, installBinDir)
		if len(kept) == len(lines) {
			continue
		}
		if err := os.WriteFile(file, []byte(strings.Join(kept, "\n")+"\n"), 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "无法写入 %s：%v\n", file, err)
			continue
		}
		fmt.Printf("已从 %s 移除 PATH 条目\n", file)
	}
}

// runUninstall 执行卸载：确认 → 回滚 PATH → 删除安装根。返回进程退出码。
// PATH 回滚与安装根删除的平台实现见 uninstall_windows.go / uninstall_posix.go。
func runUninstall(root string, args []string) int {
	opts, err := parseUninstallArgs(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	record, err := readInstallRecord(filepath.Join(root, "install.json"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "未检测到受管安装（install.json 不存在或无效）。")
		fmt.Fprintln(os.Stderr, "若为便携模式，直接删除可执行文件及同目录 .aizen 目录即可，无需执行卸载。")
		return 1
	}
	if !confirmUninstall(opts.yes) {
		fmt.Println("已取消卸载")
		return 0
	}
	fmt.Printf("卸载来源：%s %s（%s）\n", record.Channel, record.Version, record.Platform)
	if !opts.skipPath {
		removePathEntries(root)
	}
	if err := removeInstallRoot(root); err != nil {
		fmt.Fprintf(os.Stderr, "删除安装目录失败：%v\n", err)
		return 1
	}
	suffix := "，PATH 已回滚"
	if opts.skipPath {
		suffix = "（--skip-path，未触碰 PATH）"
	}
	fmt.Printf("卸载完成：安装目录已删除%s\n", suffix)
	return 0
}
