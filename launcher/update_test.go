package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// 版本比较语义与主程序 self-update.ts 保持一致（含预发布后缀规则）。
func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int // 仅比符号
	}{
		{"0.2.0", "0.1.0", 1},
		{"0.1.0", "0.2.0", -1},
		{"0.1.0", "0.1.0", 0},
		{"1.0.0", "0.9.9", 1},
		// 无预发布 > 有预发布
		{"0.2.0", "0.2.0-beta.1", 1},
		{"0.2.0-beta.1", "0.2.0", -1},
		// 预发布标识符：数字按数值比较
		{"0.2.0-beta.2", "0.2.0-beta.1", 1},
		{"0.2.0-beta.10", "0.2.0-beta.9", 1},
		// 数字 < 字母
		{"0.2.0-alpha", "0.2.0-1", 1},
		// 标识符少的更小
		{"0.2.0-beta.1", "0.2.0-beta", 1},
		// 字母按 ASCII
		{"0.2.0-beta", "0.2.0-alpha", 1},
	}
	sign := func(n int) int {
		if n > 0 {
			return 1
		}
		if n < 0 {
			return -1
		}
		return 0
	}
	for _, c := range cases {
		if got := sign(compareVersions(c.a, c.b)); got != c.want {
			t.Errorf("compareVersions(%q, %q) 符号 = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

// GC 候选：排除 current 后按版本降序保留最高一个，其余待删；不足两个历史版本时不删。
func TestGcCandidates(t *testing.T) {
	cases := []struct {
		name    string
		entries []string
		keep    string
		want    []string
	}{
		{"两个历史版本删除较旧的", []string{"v0.1.0", "v0.2.0", "v0.3.0"}, "v0.3.0", []string{"v0.1.0"}},
		{"单个历史版本保留", []string{"v0.2.0", "v0.3.0"}, "v0.3.0", nil},
		{"无历史版本", []string{"v0.3.0"}, "v0.3.0", nil},
		{"非 v 前缀条目忽略", []string{"v0.1.0", "v0.2.0", "v0.3.0", "tmp"}, "v0.3.0", []string{"v0.1.0"}},
		{"预发布版本参与排序", []string{"v0.2.0-beta.1", "v0.2.0", "v0.3.0"}, "v0.3.0", []string{"v0.2.0-beta.1"}},
	}
	for _, c := range cases {
		if got := gcCandidates(c.entries, c.keep); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: gcCandidates(%v, %q) = %v, want %v", c.name, c.entries, c.keep, got, c.want)
		}
	}
}

// SHA256SUMS 解析：匹配行取校验和，缺失返回空。
func TestExpectedChecksum(t *testing.T) {
	sums := "abc123  aizen-assistant-0.2.0-windows-x64.zip\r\ndef456  other.zip\n"
	if got := expectedChecksum(sums, "aizen-assistant-0.2.0-windows-x64.zip"); got != "abc123" {
		t.Fatalf("expectedChecksum = %q, want abc123", got)
	}
	if got := expectedChecksum(sums, "missing.zip"); got != "" {
		t.Fatalf("缺失文件应返回空，got %q", got)
	}
}

// update 参数解析：--release-api / --pre / 忽略 --data-dir / 拒绝未知参数。
func TestParseUpdateArgs(t *testing.T) {
	opts, err := parseUpdateArgs([]string{"--release-api", "http://x", "--pre"})
	if err != nil {
		t.Fatal(err)
	}
	if opts.releaseAPI != "http://x" || !opts.includePre {
		t.Fatalf("解析结果异常：%+v", opts)
	}

	if _, err := parseUpdateArgs([]string{"--data-dir", "/d"}); err != nil {
		t.Fatalf("--data-dir 应被接受并忽略：%v", err)
	}
	if _, err := parseUpdateArgs([]string{"--force"}); err == nil {
		t.Fatal("未知参数应报错")
	}
	if _, err := parseUpdateArgs([]string{"--release-api"}); err == nil {
		t.Fatal("--release-api 缺值应报错")
	}
}

// launcher 自更新（rename 方案）：内容不同则换位、留 .old 残留可被下次清理；内容相同则短路。
func TestSelfUpdateLauncher(t *testing.T) {
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	current := filepath.Join(binDir, executableName())
	if err := os.WriteFile(current, []byte("old-launcher"), 0o755); err != nil {
		t.Fatal(err)
	}
	newLauncher := filepath.Join(root, "new-launcher")
	if err := os.WriteFile(newLauncher, []byte("new-launcher"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := selfUpdateLauncher(root, newLauncher); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(current)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "new-launcher" {
		t.Fatalf("换位后内容 = %q, want new-launcher", data)
	}

	// 内容一致时短路：不产生新残留
	before, _ := filepath.Glob(filepath.Join(binDir, "*.old"))
	if err := selfUpdateLauncher(root, newLauncher); err != nil {
		t.Fatal(err)
	}
	after, _ := filepath.Glob(filepath.Join(binDir, "*.old"))
	if len(after) > len(before) {
		t.Fatalf("哈希一致时不应产生新残留：before=%v after=%v", before, after)
	}
}

// 原子写安装记录：写入后可读回，临时文件不残留。
func TestWriteInstallRecord(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "install.json")
	record := &installRecord{Channel: "github", Version: "0.2.0", Platform: "windows-x64", Current: "v0.2.0"}
	if err := writeInstallRecord(path, record); err != nil {
		t.Fatal(err)
	}
	loaded, err := readInstallRecord(path)
	if err != nil {
		t.Fatal(err)
	}
	if *loaded != *record {
		t.Fatalf("读回 = %+v, want %+v", loaded, record)
	}
	leftovers, _ := filepath.Glob(filepath.Join(dir, "*.tmp"))
	if len(leftovers) != 0 {
		t.Fatalf("临时文件残留：%v", leftovers)
	}
}
