//go:build !windows

// POSIX 端启动实现：用 exec 系统调用替换自身进程（与原 shell launcher 的 exec 语义一致，不留双进程）。
package main

import (
	"fmt"
	"os"
	"syscall"
)

// runTarget 以 exec 语义启动真实可执行文件：成功时当前进程被完全替换、不返回；失败时报错退出。
// 参数 args 不含 argv[0]，本函数负责按 exec 约定补上。
func runTarget(exe string, args []string) {
	argv := append([]string{exe}, args...)
	if err := syscall.Exec(exe, argv, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "启动失败：%v\n", err)
		os.Exit(1)
	}
}
