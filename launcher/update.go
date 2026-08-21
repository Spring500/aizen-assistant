package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// executableName 主程序可执行文件名（Windows 带 .exe 后缀）。
func executableName() string {
	if runtime.GOOS == "windows" {
		return "aizen-assistant.exe"
	}
	return "aizen-assistant"
}

// packageLauncherName 发布包内 launcher 的文件名。
func packageLauncherName() string {
	if runtime.GOOS == "windows" {
		return "launcher.exe"
	}
	return "launcher"
}

// updateOptions update 子命令的选项。
type updateOptions struct {
	releaseAPI string // API 基地址（--release-api；测试或自建镜像场景传入）
	includePre bool   // --pre：查询含 Draft/Prerelease 的最高版本（Draft 需 token）
	token      string // GITHUB_TOKEN：预发布测试用；空则匿名（仅见正式发布）
}

// parseUpdateArgs 解析 update 子命令参数；--data-dir 接受并忽略（launcher 对任意调用形态注入默认参数）。
func parseUpdateArgs(args []string) (*updateOptions, error) {
	opts := &updateOptions{
		releaseAPI: "https://api.github.com/repos/Spring500/aizen-assistant",
		token:      os.Getenv("GITHUB_TOKEN"),
	}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--release-api":
			i++
			if i >= len(args) || strings.HasPrefix(args[i], "--") {
				return nil, fmt.Errorf("--release-api 必须提供值")
			}
			opts.releaseAPI = args[i]
		case "--pre":
			opts.includePre = true
		case "--data-dir":
			i++ // 接受并忽略（含值）
		default:
			return nil, fmt.Errorf("update 只接受 --release-api 与 --pre 参数")
		}
	}
	return opts, nil
}

// runUpdate 执行更新：查询 → 下载 → SHA256 校验 → 解压 → 落位版本目录 →
// 更新 launcher 自身 → 原子切换 install.json → GC 历史版本。返回进程退出码。
func runUpdate(root string, args []string) int {
	opts, err := parseUpdateArgs(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	record, err := readInstallRecord(filepath.Join(root, "install.json"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if record.Channel != "github" {
		fmt.Println("当前通道无需自更新，请按对应安装方式更新。")
		return 0
	}

	client := newGithubClient(opts.releaseAPI, opts.token)
	var target *release
	if opts.includePre {
		target, err = client.latestIncludingPrereleases()
	} else {
		target, err = client.latestRelease()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if len(target.TagName) < 2 || target.TagName[0] != 'v' {
		fmt.Fprintln(os.Stderr, "最新 release 的 tag 格式异常")
		return 1
	}
	version := target.TagName[1:]
	if compareVersions(version, record.Version) <= 0 {
		fmt.Printf("已是最新版本：%s\n", record.Version)
		return 0
	}

	if err := applyUpdate(root, record, client, target, version); err != nil {
		fmt.Fprintf(os.Stderr, "更新失败：%v\n", err)
		return 1
	}
	fmt.Printf("更新完成：%s → %s\n", record.Version, version)
	return 0
}

// applyUpdate 下载并落位新版本（更新的事务主体；任一步失败则 install.json 不切换，现有版本不受影响）。
func applyUpdate(root string, record *installRecord, client *githubClient, target *release, version string) error {
	assetName := fmt.Sprintf("aizen-assistant-%s-%s.zip", version, record.Platform)
	asset := findAsset(target, assetName)
	if asset == nil {
		return fmt.Errorf("发布中找不到当前平台（%s）的资产：%s", record.Platform, assetName)
	}
	sumsAsset := findAsset(target, "SHA256SUMS")
	if sumsAsset == nil {
		return fmt.Errorf("发布缺少 SHA256SUMS 资产，无法校验，已中止更新")
	}

	workDir, err := os.MkdirTemp("", "aizen-update-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(workDir)

	zipPath := filepath.Join(workDir, assetName)
	fmt.Printf("下载 %s ...\n", assetName)
	if err := client.downloadAsset(asset, zipPath); err != nil {
		return err
	}
	sumsPath := filepath.Join(workDir, "SHA256SUMS")
	if err := client.downloadAsset(sumsAsset, sumsPath); err != nil {
		return err
	}
	sumsText, err := os.ReadFile(sumsPath)
	if err != nil {
		return err
	}
	expected := expectedChecksum(string(sumsText), assetName)
	if expected == "" {
		return fmt.Errorf("SHA256SUMS 中找不到 %s 的校验和，已中止更新", assetName)
	}
	actual, err := sha256Of(zipPath)
	if err != nil {
		return err
	}
	if expected != actual {
		return fmt.Errorf("SHA256 校验失败，已中止更新")
	}

	extracted := filepath.Join(workDir, "extracted")
	if err := extractZip(zipPath, extracted); err != nil {
		return err
	}
	packageExe := filepath.Join(extracted, executableName())
	if _, err := os.Stat(packageExe); err != nil {
		return fmt.Errorf("压缩包内未找到可执行文件")
	}

	// 新版本落位到 versions/v<版本>/（同卷临时名 + 原子 rename）
	versionDir := filepath.Join(root, "versions", "v"+version)
	if err := os.MkdirAll(versionDir, 0o755); err != nil {
		return err
	}
	targetExe := filepath.Join(versionDir, executableName())
	staged := filepath.Join(versionDir, fmt.Sprintf(".tmp-%d", os.Getpid()))
	if err := copyFileWithMode(packageExe, staged, 0o755); err != nil {
		return err
	}
	_ = os.Remove(targetExe)
	if err := os.Rename(staged, targetExe); err != nil {
		_ = os.Remove(staged)
		return err
	}

	// launcher 自更新：失败不阻塞更新（主程序版本切换不依赖 launcher 更新成功）
	if err := selfUpdateLauncher(root, filepath.Join(extracted, packageLauncherName())); err != nil {
		fmt.Fprintf(os.Stderr, "警告：launcher 更新未完成（%v），主程序更新不受影响\n", err)
	}

	newRecord := &installRecord{Channel: "github", Version: version, Platform: record.Platform, Current: "v" + version}
	if err := writeInstallRecord(filepath.Join(root, "install.json"), newRecord); err != nil {
		return err
	}
	gcVersions(root, "v"+version)
	return nil
}

// copyFileWithMode 复制文件并设置权限位。
func copyFileWithMode(src, dst string, mode os.FileMode) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, mode)
}

// gcVersions 清理 versions/ 下除 current 之外的历史版本（保留最近一个供回滚；删除失败忽略——
// 可能被运行中的实例占用，留待下次更新清理）。
func gcVersions(root, keepCurrent string) {
	versionsDir := filepath.Join(root, "versions")
	entries, err := os.ReadDir(versionsDir)
	if err != nil {
		return
	}
	for _, name := range gcCandidates(entryNames(entries), keepCurrent) {
		_ = os.RemoveAll(filepath.Join(versionsDir, name))
	}
}

// entryNames 提取目录项名称列表。
func entryNames(entries []os.DirEntry) []string {
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

// gcCandidates 从版本目录名列表中选出应删除的历史版本：排除 current 后按版本降序，保留最高的一个。
// 独立为纯函数便于单测。
func gcCandidates(names []string, keepCurrent string) []string {
	others := make([]string, 0, len(names))
	for _, name := range names {
		if strings.HasPrefix(name, "v") && name != keepCurrent {
			others = append(others, name)
		}
	}
	// 简单插入排序（按版本降序）：候选数量极小，无需引入 sort 闭包
	for i := 1; i < len(others); i++ {
		for j := i; j > 0 && compareVersions(strings.TrimPrefix(others[j], "v"), strings.TrimPrefix(others[j-1], "v")) > 0; j-- {
			others[j], others[j-1] = others[j-1], others[j]
		}
	}
	if len(others) <= 1 {
		return nil
	}
	return others[1:]
}

// selfUpdateLauncher 用发布包内的新 launcher 替换 bin/ 下的自身（rename 方案）：
// Windows 不允许覆盖运行中的 exe 但允许重命名，流程为：
// 清理历史残留 → SHA256 比对短路 → 同卷暂存 → rename 自身为 <原名>.<pid>.old →
// rename 暂存到原名（失败则把 .old 改回原名回滚）→ 尽力删除 .old（被锁时静默保留，下次清理）。
// 残留名带 pid 保证每次 rename 目标唯一，不与被锁的历史残留冲突。
func selfUpdateLauncher(root, newLauncher string) error {
	if _, err := os.Stat(newLauncher); err != nil {
		return fmt.Errorf("发布包内未找到 launcher")
	}
	binDir := filepath.Join(root, "bin")
	current := filepath.Join(binDir, executableName())

	// 清理历史残留（*.old）：删除失败说明仍被占用，跳过
	if matches, err := filepath.Glob(filepath.Join(binDir, "*.old")); err == nil {
		for _, stale := range matches {
			_ = os.Remove(stale)
		}
	}

	// 哈希一致则跳过（launcher 极少变化，多数更新走到这里结束，不制造残留）
	currentHash, err := sha256Of(current)
	if err == nil {
		newHash, err := sha256Of(newLauncher)
		if err == nil && currentHash == newHash {
			return nil
		}
	}

	staged := filepath.Join(binDir, fmt.Sprintf(".launcher-staged-%d", os.Getpid()))
	if err := copyFileWithMode(newLauncher, staged, 0o755); err != nil {
		return err
	}
	old := fmt.Sprintf("%s.%d.old", current, os.Getpid())
	if err := os.Rename(current, old); err != nil {
		_ = os.Remove(staged)
		return fmt.Errorf("无法移开当前 launcher：%w", err)
	}
	if err := os.Rename(staged, current); err != nil {
		// 回滚：旧 launcher 文件未损坏（仅改名），改回原名必然可行，避免 bin/ 缺失启动入口
		_ = os.Rename(old, current)
		_ = os.Remove(staged)
		return fmt.Errorf("新 launcher 落位失败：%w", err)
	}
	// Windows 下自身仍在运行、删除预期失败（EACCES），静默保留待下次更新清理
	_ = os.Remove(old)
	fmt.Println("launcher 已更新（下次启动生效）")
	return nil
}
