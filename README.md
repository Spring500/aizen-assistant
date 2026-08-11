# AizenAssistant

AizenAssistant 是一个面向重度 Coding Agent 用户的本地 Coding Agent 应用，适合长期维护项目、频繁切换任务方式，并希望对 Agent 上下文做定制化管理的开发者。

## 主要特性

### 视图式上下文

你可以将系统提示词、项目规则和 Skill 组织成不同视图，为新会话选择视图，也可以在对话过程中切换——而非单纯使用工作目录下的 `AGENTS.md` 和 Skill。视图是独立的"工作预设"，目录中包含：

- `SYSTEM.md`：系统提示词；
- `AGENTS.md`：视图项目规则；
- `skills/`：视图自带的 Skill（随视图目录迁移）；
- `config.json`：行为配置（工作路径上下文加载范围、全局技能开关）。

每个视图可通过 `config.json` 决定是否加载当前工作路径的 AGENTS.md 与 Skill，以及加载范围（不加载 / 仅工作目录 / 到 git 仓库根 / 按 pi 默认），并控制是否加载全局技能。"无视图"是原生模式：内建提示词 + 全局技能 + 项目上下文，提供接近原生 Agent 的使用体验。

### 全局技能管理

全局技能是跨视图常驻的机器级资源：通过 `/skills` 输入任意 git 仓库地址（GitHub、GitLab 或自建仓库），引入并发现其中符合 SKILL.md 规范的技能，安装后全局生效。视图可在 `config.json` 关闭全局技能以获得纯净上下文。

### 显式意图声明

Agent 在执行工具前需要用自然语言简要说明调用目的，让连续的文件读取、代码修改和命令执行更容易被人理解，而不只是向用户展示一组工具参数。未来在补充权限审核与沙箱能力后，调用目的还可以作为审核操作合理性、解释权限请求和发现意图与实际行为偏差的依据。

### 便利性设计

- **助记词 ID**：会话和视图使用由三个单词组成的助记 ID，而不是难以辨认和交流的 UUID。即使没有主动命名，你仍然可以方便地查找、区分和引用它们。
- **本地管理会话**：会话以本地单文件形式保存，文件名不参与会话身份识别，可以在应用外自行改名、备份和整理。会话支持命名、恢复、回退和创建独立分支，原始记录不会因为上下文压缩而被删除。

### 后续计划

- **Agent 自省体系建设**：让 Agent 感知自己的会话名称与 ID、当前模型、视图、可用能力、上下文边界和运行状态，尽可能缩小用户与 Agent 因观察窗口不同产生的信息差异。异常中断恢复也将是其中一部分：Agent 应当知道上一次工作在哪里停止，以及停止来自用户操作还是系统异常。
- **Perforce 工作区支持**：为使用 Perforce（而非 git）管理的项目，把"当前工作区根"作为上下文加载边界，让工作路径里的 AGENTS.md 与技能只在当前工作区内向上读取。workspace 根由 Perforce 服务端维护，需要本机安装 `p4` 命令行工具并能连接服务端，本期未纳入。

### 注意事项

- 项目仍处于早期开发阶段，更新节奏有限。
- 当前提供 TUI 界面，GUI 尚在规划中。
- 暂时基于 [pi](https://github.com/earendil-works/pi) SDK 构建，后续考虑使用 `pi-ai` 并自行设计 Agent Loop。

## 安装（分发版本）

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/Spring500/aizen-assistant/main/install.sh | bash
```

Windows（PowerShell）：

```powershell
irm https://raw.githubusercontent.com/Spring500/aizen-assistant/main/install.ps1 | iex
```

国内网络可改用 jsDelivr 镜像脚本（可选）：

```bash
curl -fsSL https://cdn.jsdelivr.net/gh/Spring500/aizen-assistant@main/install.sh | bash
```

安装到 `~/.aizen/bin/`（Windows 为 `%USERPROFILE%\.aizen\bin`），只修改用户级环境，全程无需管理员权限；重复执行安全。需要指定历史版本时：`bash install.sh 0.1.0`。

**更新**：运行 `aizen-assistant update`，自动从 GitHub Releases 下载最新版并原子替换自身。

**卸载**：运行 `aizen-assistant uninstall`，确认后删除 `~/.aizen` 并回滚 PATH。

**macOS 提示**：未签名的发布版首次运行可能被 Gatekeeper 拦截，请右键点击打开，或在终端执行：

```bash
xattr -d com.apple.quarantine ~/.aizen/bin/aizen-assistant
```

## 从源码运行

项目使用 Bun workspace。安装锁定依赖并启动 TUI：

```powershell
bun install --frozen-lockfile
bun run dev:tui
```

`bun run dev:tui` 直接运行 TypeScript 源码，不编译可执行文件，也不会自动重启。无论从 worktree 内哪个目录执行，工作目录均为 worktree 根目录。

构建单文件可执行程序（默认 Windows x64）：

```powershell
bun run build:tui
```

需要其它平台时通过 `--target` 指定：

```powershell
bun run build:tui --target bun-linux-x64
bun run build:tui --target bun-darwin-arm64
```

产物位于 `dist/`（Windows 为 `aizen-assistant.exe`，其余平台为 `aizen-assistant`），运行时不要求用户另行安装 Node.js 或 Bun。

## 启动参数

| 参数 | 行为 |
|---|---|
| `--data-dir <目录>` | 指定本地数据目录；相对路径以启动时的工作目录为基准，且不能指定为当前工作目录。 |
| `--collect-permission-gaps` | 将权限规则缺口记录到 `<数据目录>/local-observations/permission-gaps.jsonl`。完全开放模式会额外运行验证器但始终放行且不触发 AI 或人工审核，其他模式复用正常验证结果。 |

## 数据存储

AizenAssistant 的数据保存在本地：

- 通过 `bun run dev:tui` 启动时，默认数据目录为 `<worktree>/.aizen/dev-data`；相对路径以 worktree 根目录为基准；
- 直接运行 `bun apps/tui/main.ts` 时必须指定 `--data-dir <目录>`；相对路径以执行命令时的当前目录为基准；
- 运行 `aizen-assistant`（通过安装脚本安装到 `~/.aizen/bin/`）时，默认数据目录为 `<可执行文件所在目录>/data`，即 `~/.aizen/bin/data`；
- 直接拷贝可执行文件到任意目录运行时，数据目录跟随可执行文件，位于其同目录的 `data/`（便携模式）；
- 以上启动方式都可以通过 `--data-dir <目录>` 改用指定的数据目录，数据目录不能直接指定为当前工作目录。

数据目录包含会话、视图、模型配置、应用偏好和认证信息。会话按工作目录分组保存在 `sessions/` 下，每个会话对应一个 JSONL 文件；文件名由本地创建时间和助记词 ID 组成，可以在应用外改名。会话文件是完整记录的事实来源，摘要索引只是可重建缓存。全局技能登记表保存在 `skills.json`，技能仓库缓存位于 `skill-sources/`。

**备份**：数据全部位于 `~/.aizen/bin/data`（便携模式为可执行文件旁的 `data/`），其余内容（可执行文件、`install.json`）均可重新安装获得。备份时复制数据目录即可。由于其中包含认证信息，分享、同步或提交前请先检查敏感内容。

开发、验证和 PR 流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。
