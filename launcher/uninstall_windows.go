//go:build windows

// Windows 端卸载实现：PATH 回滚经 PowerShell 操作 HKCU\Environment（免管理员）；
// 运行中的 launcher exe 无法删除，安装根交给延迟 PowerShell 在本进程退出后删除。
package main

import (
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// quotePowerShell 把字符串转为 PowerShell 单引号字面量（转义内部单引号）。
func quotePowerShell(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

// removePathEntries 从用户级 PATH（HKCU\Environment）移除安装目录条目。
// 同时匹配默认安装路径（$HOME\.aizen\bin）与当前安装根推导出的绝对路径（覆盖 --install-dir 场景）。
func removePathEntries(root string) {
	binDir := filepath.Join(root, "bin")
	script := strings.Join([]string{
		"$entry2 = Join-Path $HOME '.aizen\\bin'",
		"$entry3 = " + quotePowerShell(binDir),
		"$current = [Environment]::GetEnvironmentVariable('Path','User')",
		"if ($null -eq $current) { exit 0 }",
		"$parts = $current -split ';' | Where-Object { $_.Trim() -ne '' -and $_.Trim() -ne $entry2 -and $_.Trim() -ne $entry3 }",
		"$new = $parts -join ';'",
		"[Environment]::SetEnvironmentVariable('Path',$new,'User')",
	}, "; ")
	cmd := exec.Command("powershell", "-NoProfile", "-Command", script)
	if err := cmd.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "回滚用户 PATH 失败，请手动检查 HKCU\\Environment")
		return
	}
	fmt.Println("已从用户 PATH 移除安装目录")
}

// removeInstallRoot 删除安装根：运行中的 launcher exe 被系统锁定无法删除，
// 写临时 ps1 并经 Start-Process 启动独立 PowerShell 在本进程退出后删除
// （直接 spawn 的子进程会随父进程退出被终止，必须经 Start-Process 脱离父子关系）。
func removeInstallRoot(root string) error {
	script := filepath.Join(os.TempDir(), fmt.Sprintf("aizen-uninstall-%d-%d.ps1", os.Getpid(), rand.Int31()))
	lines := []string{
		"try {",
		"Start-Sleep -Seconds 1",
		"Remove-Item -Recurse -Force " + quotePowerShell(root),
		"} finally {",
		"  Remove-Item -Force " + quotePowerShell(script) + " -ErrorAction SilentlyContinue",
		"}",
		"",
	}
	// UTF-8 BOM：Windows PowerShell 5.1 无 BOM 会按 ANSI 解码导致中文注释乱码（此处纯 ASCII，防御性保留）
	content := append([]byte{0xEF, 0xBB, 0xBF}, []byte(strings.Join(lines, "\n"))...)
	if err := os.WriteFile(script, content, 0o644); err != nil {
		return err
	}
	launch := fmt.Sprintf(
		"Start-Process -WindowStyle Hidden powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',%s",
		quotePowerShell(script),
	)
	cmd := exec.Command("powershell", "-NoProfile", "-Command", launch)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("启动延迟删除失败：%w", err)
	}
	return nil
}
