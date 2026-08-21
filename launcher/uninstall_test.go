package main

import (
	"reflect"
	"testing"
)

// PATH 行过滤语义与主程序 tests/tui/self-uninstall.test.ts 逐条对照（TS→Go 移植的一致性锁定）。
func TestFilterInstalledPathLines(t *testing.T) {
	cases := []struct {
		name  string
		lines []string
		bin   string
		want  []string
	}{
		{
			"移除安装脚本写入的 PATH 行",
			[]string{`export PATH="$HOME/.aizen/bin:$PATH"`, "export FOO=bar", "fish_add_path $HOME/.aizen/bin"},
			"/home/user/.aizen/bin",
			[]string{"export FOO=bar"},
		},
		{
			"移除手写绝对路径的条目",
			[]string{`export PATH="/home/user/.aizen/bin:$PATH"`, "export FOO=bar"},
			"/home/user/.aizen/bin",
			[]string{"export FOO=bar"},
		},
		{
			"保留无关行",
			[]string{`export PATH="/usr/local/bin:$PATH"`, "# comment", ""},
			"/home/user/.aizen/bin",
			[]string{`export PATH="/usr/local/bin:$PATH"`, "# comment", ""},
		},
	}
	for _, c := range cases {
		if got := filterInstalledPathLines(c.lines, c.bin); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: filterInstalledPathLines(%v) = %v, want %v", c.name, c.lines, got, c.want)
		}
	}
}

// uninstall 参数解析：--yes / --skip-path / 忽略 --data-dir / 拒绝未知参数。
func TestParseUninstallArgs(t *testing.T) {
	opts, err := parseUninstallArgs([]string{"--yes", "--skip-path"})
	if err != nil {
		t.Fatal(err)
	}
	if !opts.yes || !opts.skipPath {
		t.Fatalf("解析结果异常：%+v", opts)
	}

	if _, err := parseUninstallArgs([]string{"--data-dir", "/d", "--yes"}); err != nil {
		t.Fatalf("--data-dir 应被接受并忽略：%v", err)
	}
	if _, err := parseUninstallArgs([]string{"--force"}); err == nil {
		t.Fatal("未知参数应报错")
	}
}
