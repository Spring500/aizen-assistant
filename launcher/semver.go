package main

import (
	"strconv"
	"strings"
)

type parsedVersion struct {
	core [3]int
	pre  []string
}

func parseVersion(value string) parsedVersion {
	var parsed parsedVersion
	core, preText, _ := strings.Cut(value, "-")
	parts := strings.Split(core, ".")
	for i := 0; i < 3 && i < len(parts); i++ {
		n, err := strconv.Atoi(parts[i])
		if err == nil {
			parsed.core[i] = n
		}
	}
	if preText != "" {
		parsed.pre = strings.Split(preText, ".")
	}
	return parsed
}

func parseNumericIdentifier(id string) (int, bool) {
	if id == "" {
		return 0, false
	}
	for _, r := range id {
		if r < '0' || r > '9' {
			return 0, false
		}
	}
	n, err := strconv.Atoi(id)
	return n, err == nil
}

// compareVersions 比较语义化版本（x.y.z，可选预发布后缀如 -beta.1）：
// a 大于 b 返回正数，相等返回 0，否则负数。与主程序 self-update.ts 的实现语义一致：
// 无预发布 > 有预发布；预发布标识符逐个比较（数字按数值、字母按 ASCII；数字 < 字母；标识符少的更小）。
func compareVersions(a, b string) int {
	pa := parseVersion(a)
	pb := parseVersion(b)
	for i := 0; i < 3; i++ {
		if d := pa.core[i] - pb.core[i]; d != 0 {
			return d
		}
	}
	if pa.pre == nil && pb.pre != nil {
		return 1
	}
	if pa.pre != nil && pb.pre == nil {
		return -1
	}
	if pa.pre == nil {
		return 0
	}
	length := len(pa.pre)
	if len(pb.pre) > length {
		length = len(pb.pre)
	}
	for i := 0; i < length; i++ {
		if i >= len(pa.pre) {
			return -1
		}
		if i >= len(pb.pre) {
			return 1
		}
		aNumber, aNumeric := parseNumericIdentifier(pa.pre[i])
		bNumber, bNumeric := parseNumericIdentifier(pb.pre[i])
		switch {
		case aNumeric && bNumeric:
			if d := aNumber - bNumber; d != 0 {
				return d
			}
		case aNumeric:
			return -1
		case bNumeric:
			return 1
		default:
			if pa.pre[i] != pb.pre[i] {
				if pa.pre[i] < pb.pre[i] {
					return -1
				}
				return 1
			}
		}
	}
	return 0
}
