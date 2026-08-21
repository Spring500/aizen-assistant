//go:build !windows

// POSIX 端卸载实现：PATH 回滚重写 shell 配置文件；安装根可直接删除（允许删除运行中的可执行文件）。
package main

import "os"

// removePathEntries 回滚 PATH：从 bash/zsh/fish 配置文件中移除安装写入的 PATH 行。
func removePathEntries(root string) {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	removeShellPathEntries(home, root)
}

// removeInstallRoot 删除整个安装根（POSIX 允许删除运行中的可执行文件）。
func removeInstallRoot(root string) error {
	return os.RemoveAll(root)
}
