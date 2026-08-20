package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// sha256Of 计算文件 SHA256（hex 小写）。
func sha256Of(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

// expectedChecksum 从 SHA256SUMS 内容中取指定文件的校验和；找不到返回空串。
func expectedChecksum(sumsText, name string) string {
	for _, line := range strings.Split(sumsText, "\n") {
		line = strings.TrimRight(line, "\r ")
		if strings.HasSuffix(line, name) {
			fields := strings.Fields(line)
			if len(fields) > 0 {
				return strings.ToLower(fields[0])
			}
		}
	}
	return ""
}

// extractZip 解压 zip 到目标目录（Go 标准库实现，无外部命令依赖）。
// 防 zip-slip：拒绝解压路径逃逸出目标目录的条目。
func extractZip(zipPath, destDir string) error {
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("打开压缩包失败：%w", err)
	}
	defer reader.Close()
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return err
	}
	for _, entry := range reader.File {
		target := filepath.Join(destDir, entry.Name)
		if !strings.HasPrefix(target, filepath.Clean(destDir)+string(os.PathSeparator)) {
			return fmt.Errorf("压缩包含非法路径条目：%s", entry.Name)
		}
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := extractZipEntry(entry, target); err != nil {
			return err
		}
	}
	return nil
}

// extractZipEntry 解压单个 zip 条目到目标路径（保留可执行权限位）。
func extractZipEntry(entry *zip.File, target string) error {
	src, err := entry.Open()
	if err != nil {
		return err
	}
	defer src.Close()
	mode := entry.Mode().Perm()
	if mode == 0 {
		mode = 0o644
	}
	dst, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer dst.Close()
	_, err = io.Copy(dst, src)
	return err
}
