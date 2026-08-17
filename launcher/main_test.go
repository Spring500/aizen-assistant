package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// 构造 <根>/bin/launcher 布局，验证向上两级得到安装根（跨平台）。
func TestInstallRoot(t *testing.T) {
	root := filepath.Join("x", ".aizen")
	launcher := filepath.Join(root, "bin", "launcher")
	if got := installRoot(launcher); got != root {
		t.Fatalf("installRoot(%q) = %q, want %q", launcher, got, root)
	}
}

// 交互模式注入 --data-dir；update / uninstall 分发子命令不注入。
func TestShouldInjectDataDir(t *testing.T) {
	cases := []struct {
		args []string
		want bool
	}{
		{[]string{}, true},
		{[]string{"--data-dir", "/x"}, true},
		{[]string{"update"}, false},
		{[]string{"update", "--release-api", "url"}, false},
		{[]string{"uninstall", "--yes"}, false},
	}
	for _, c := range cases {
		if got := shouldInjectDataDir(c.args); got != c.want {
			t.Errorf("shouldInjectDataDir(%v) = %v, want %v", c.args, got, c.want)
		}
	}
}

// 真实可执行文件路径指向 versions/<current>/，Windows 带 .exe 后缀。
func TestExecutablePath(t *testing.T) {
	root := filepath.Join("x", ".aizen")
	got := executablePath(root, "v0.2.0")
	name := "aizen-assistant"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	want := filepath.Join(root, "versions", "v0.2.0", name)
	if got != want {
		t.Fatalf("executablePath = %q, want %q", got, want)
	}
}

// 安装记录解析：含 current 正常读取，缺失 current 或文件不存在时报错。
func TestReadInstallRecord(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "install.json")

	if err := os.WriteFile(path, []byte(`{"current": "v0.2.0", "version": "0.2.0"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	record, err := readInstallRecord(path)
	if err != nil {
		t.Fatal(err)
	}
	if record.Current != "v0.2.0" {
		t.Fatalf("current = %q, want v0.2.0", record.Current)
	}

	if err := os.WriteFile(path, []byte(`{"version": "0.1.0"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readInstallRecord(path); err == nil {
		t.Fatal("缺少 current 应报错")
	}

	if _, err := readInstallRecord(filepath.Join(dir, "missing.json")); err == nil {
		t.Fatal("文件不存在应报错")
	}
}
