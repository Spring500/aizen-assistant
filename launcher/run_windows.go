//go:build windows

// Windows 端启动实现：无 exec 系统调用，启动子进程、透传 stdio 与退出码。
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
)

// runTarget 启动真实可执行文件并等待其退出，透传标准输入输出与退出码。
// Ctrl+C 由子进程（TUI）处理，launcher 忽略信号、只负责透传退出码。
func runTarget(exe string, args []string) {
	cmd := exec.Command(exe, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	signal.Ignore(os.Interrupt)
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			os.Exit(exitErr.ExitCode())
		}
		fmt.Fprintf(os.Stderr, "启动失败：%v\n", err)
		os.Exit(1)
	}
	os.Exit(0)
}
