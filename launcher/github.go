package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// releaseAsset GitHub release 资产：匿名下载用 BrowserDownloadURL，token 模式（含 Draft）用 ID 走资产 API。
type releaseAsset struct {
	ID                 int64  `json:"id"`
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// release GitHub release 条目（仅消费 update 所需字段）。
type release struct {
	TagName    string         `json:"tag_name"`
	Draft      bool           `json:"draft"`
	Prerelease bool           `json:"prerelease"`
	Assets     []releaseAsset `json:"assets"`
}

// githubClient 访问 GitHub release API 的最小客户端；token 为空时匿名访问（仅见正式发布）。
type githubClient struct {
	apiBase string
	token   string
	http    *http.Client
}

func newGithubClient(apiBase, token string) *githubClient {
	return &githubClient{apiBase: apiBase, token: token, http: &http.Client{Timeout: 120 * time.Second}}
}

func (c *githubClient) request(method, url, accept string) (*http.Response, error) {
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "aizen-assistant")
	req.Header.Set("Accept", accept)
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		resp.Body.Close()
		return nil, fmt.Errorf("HTTP %d（%s）", resp.StatusCode, url)
	}
	return resp, nil
}

// latestRelease 查询最新正式发布（releases/latest；GitHub 天然排除 Draft 与 Prerelease）。
func (c *githubClient) latestRelease() (*release, error) {
	resp, err := c.request("GET", c.apiBase+"/releases/latest", "application/vnd.github+json")
	if err != nil {
		return nil, fmt.Errorf("查询最新版本失败：%w", err)
	}
	defer resp.Body.Close()
	var r release
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, fmt.Errorf("解析最新版本响应失败：%w", err)
	}
	return &r, nil
}

// latestIncludingPrereleases 查询含 Draft/Prerelease 的最高版本（--pre 模式；Draft 仅 token 可见）。
func (c *githubClient) latestIncludingPrereleases() (*release, error) {
	resp, err := c.request("GET", c.apiBase+"/releases?per_page=100", "application/vnd.github+json")
	if err != nil {
		return nil, fmt.Errorf("查询发布列表失败：%w", err)
	}
	defer resp.Body.Close()
	var releases []release
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return nil, fmt.Errorf("解析发布列表响应失败：%w", err)
	}
	var best *release
	for i := range releases {
		r := &releases[i]
		if len(r.TagName) < 2 || r.TagName[0] != 'v' {
			continue
		}
		if best == nil || compareVersions(r.TagName[1:], best.TagName[1:]) > 0 {
			best = r
		}
	}
	if best == nil {
		return nil, fmt.Errorf("发布列表为空或无合法 tag")
	}
	return best, nil
}

// downloadAsset 下载资产到本地路径：token 模式走资产 API（Draft 资产无匿名 URL），匿名模式走 browser_download_url。
func (c *githubClient) downloadAsset(asset *releaseAsset, dest string) error {
	url := asset.BrowserDownloadURL
	accept := "application/vnd.github+json"
	if c.token != "" {
		url = fmt.Sprintf("%s/releases/assets/%d", c.apiBase, asset.ID)
		accept = "application/octet-stream"
	}
	resp, err := c.request("GET", url, accept)
	if err != nil {
		return fmt.Errorf("下载 %s 失败：%w", asset.Name, err)
	}
	defer resp.Body.Close()
	file, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer file.Close()
	if _, err := io.Copy(file, resp.Body); err != nil {
		return fmt.Errorf("写入 %s 失败：%w", asset.Name, err)
	}
	return nil
}

// findAsset 在 release 中按名称查找资产；找不到返回 nil。
func findAsset(r *release, name string) *releaseAsset {
	for i := range r.Assets {
		if r.Assets[i].Name == name {
			return &r.Assets[i]
		}
	}
	return nil
}
