package main

import (
	"os"
	"path/filepath"
	"reflect"
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

// 默认参数合并：用户未传的 flag 前置注入，已显式传入的跳过；用户参数保持原顺序。
func TestMergeDefaults(t *testing.T) {
	defaults := [][]string{
		{"--data-dir", "/root/data"},
	}
	cases := []struct {
		name string
		args []string
		want []string
	}{
		{"无参数时注入全部默认项", []string{}, []string{"--data-dir", "/root/data"}},
		{"用户已传 --data-dir 时跳过注入", []string{"--data-dir", "/x"}, []string{"--data-dir", "/x"}},
		{"其余参数不影响注入且顺序保持", []string{"--theme", "dark"}, []string{"--data-dir", "/root/data", "--theme", "dark"}},
		{"子命令同样注入（launcher 对子命令零认知）", []string{"doctor"}, []string{"--data-dir", "/root/data", "doctor"}},
	}
	for _, c := range cases {
		if got := mergeDefaults(defaults, c.args); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: mergeDefaults(%v) = %v, want %v", c.name, c.args, got, c.want)
		}
	}
}

// 多个默认项独立判断：命中一项不影响其它项注入。
func TestMergeDefaultsMultiple(t *testing.T) {
	defaults := [][]string{
		{"--data-dir", "/root/data"},
		{"--flag-b", "vb"},
	}
	got := mergeDefaults(defaults, []string{"--flag-b", "user"})
	want := []string{"--data-dir", "/root/data", "--flag-b", "user"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mergeDefaults = %v, want %v", got, want)
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
