package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// installRecord 安装记录（与 packages/core/install-record.ts 的 InstallRecord 对应）。
// launcher 启动路径仅消费 Current；update 子命令读写全部字段。
type installRecord struct {
	Channel  string `json:"channel"`
	Version  string `json:"version"`
	Platform string `json:"platform"`
	Current  string `json:"current"`
}

// readInstallRecord 读取 install.json 并校验 current 字段；失败时返回用户可读的错误。
func readInstallRecord(recordPath string) (*installRecord, error) {
	data, err := os.ReadFile(recordPath)
	if err != nil {
		return nil, fmt.Errorf("无法读取安装记录 %s：%w", recordPath, err)
	}
	var record installRecord
	if err := json.Unmarshal(data, &record); err != nil || record.Current == "" {
		return nil, errors.New("安装记录缺少 current 字段，请重新安装")
	}
	return &record, nil
}

// writeInstallRecord 原子写入 install.json：同目录临时文件 + rename 落位。
// install.json 是 launcher 选择版本目录的依据，直接覆盖写在写入中途被并发启动的
// launcher 读到会得到截断 JSON；与 bun 侧 writeInstallRecord 的原子语义保持一致。
func writeInstallRecord(recordPath string, record *installRecord) error {
	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	staged := filepath.Join(filepath.Dir(recordPath), fmt.Sprintf(".install-%d.tmp", os.Getpid()))
	if err := os.WriteFile(staged, append(data, '\n'), 0o644); err != nil {
		return err
	}
	if err := os.Rename(staged, recordPath); err != nil {
		_ = os.Remove(staged)
		return err
	}
	return nil
}
