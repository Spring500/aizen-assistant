---
title: 权限系统内置分类器说明
type: spec
module: permission
sort: 2
---

# 权限系统内置分类器说明

本文说明 Aizen 当前随应用发布的内置权限分类器：它们覆盖哪些工具和命令、会产生哪些行为标签，以及遇到哪些输入时会弃权。

本文描述的是**当前实现状态**。权限系统的总体机制见[《权限系统使用说明》](./usage.md)，分类器接口、策略和审核流程见[《权限系统实现规格》](./spec.md)。

---

## 1. 当前内置分类器

当前提供两个内置分类器：

| 分类器 ID | 覆盖范围 |
|---|---|
| `builtin/file@1` | `read`、`write`、`edit`、`grep`、`find`、`ls` |
| `builtin/bash@1` | `bash`：解析器 + 安全只读/网络/git/包管理器/文件操作/系统更改命令族 |

多个分类器可以同时对同一调用作出断言，最终标签取并集。某个分类器弃权不会否定其他分类器的结果；所有匹配分类器都弃权时，调用才进入 `unknown`。

分类器产生的每条内置断言都带有证据理由，例如解析后的目标路径或识别出的 npm 子命令。这些理由会用于审核界面和权限记录。

---

## 2. 文件工具分类器

### 2.1 覆盖工具

`builtin/file@1` 覆盖六个工具：

| 工具 | 行为 |
|---|---|
| `read` | 读取指定文件 |
| `grep` | 搜索指定文件或目录内容 |
| `find` | 在指定目录中查找文件 |
| `ls` | 列出指定目录 |
| `write` | 创建或改写指定文件 |
| `edit` | 编辑指定文件 |

`grep`、`find`、`ls` 现已作为 Aizen 基础工具启用，与 `read`、`write`、`edit`、`bash` 一样要求 Agent 声明调用意图，并在执行前经过权限判断。

### 2.2 路径来源

分类器从工具参数的 `path` 字段取得目标路径：

- 相对路径以工具调用的 cwd 为基准；
- `grep`、`find`、`ls` 未提供 `path` 时以 cwd 为目标；
- 已存在路径使用 `realpath` 解析符号链接；
- 新路径从最近的已存在父目录开始解析，再拼接尚不存在的部分。

路径字段不是字符串、参数不是对象或路径无法可靠解析时，分类器弃权。

### 2.3 标签生成

读取类工具产生 `read-*`，写入类工具产生 `edit-*`。同一路径可以同时命中多个作用域：

| 条件 | 读取标签 | 写入标签 |
|---|---|---|
| 目标位于工作区 | `read-workspace` | `edit-workspace` |
| 目标位于用户目录 | `read-home` | `edit-home` |
| 目标同时位于工作区和用户目录 | 两个标签同时产生 | 两个标签同时产生 |
| 目标不在工作区和用户目录 | `read-system` | `edit-system` |
| 目标命中敏感路径 | 额外产生 `read-sensitive` | 额外产生 `edit-sensitive` |

当前 Core 向分类器提供的敏感路径名包括：

```text
.env、.npmrc、.pypirc、credentials、id_rsa、id_ed25519、
.ssh、.git、auth.json
```

当前匹配规则为：不含路径分隔符的配置按完整路径段匹配；含路径分隔符的配置按规范化路径片段匹配。匹配不区分大小写。

### 2.4 应用数据目录保护

`write` 或 `edit` 的目标路径位于应用数据目录内时，分类器除文件作用域标签外还会产生 `violation`。`violation` 固定拒绝，不受预设和审核方式影响。

---

## 3. Bash 分类器

### 3.1 解析与分类流程

`builtin/bash@1` 接入独立解析器（`packages/core/tool-permissions/parsers/bash.ts`），流程为：解析 → 逐节点分类 → 声称标签。

解析器支持：

- 命令拆分：管道、`&&`、`||`、`;`、换行作为分隔符，拆出的节点各自分类，整条命令取最严处置；
- 单引号、双引号与反斜杠转义；
- 可执行文件可带静态目录前缀。

解析器判定三类结果：

- **结构性拒绝**（分类器声称 `violation` 固定拒绝）：`eval`、`source`/`.`、函数定义、alias 定义、fork bomb；
- **unknown**（分类器弃权转人工）：变量展开（`$TARGET`、`${TARGET}`）、命令替换（`$(command)`、反引号）、单字符重定向与控制语法（`>`、`<`、裸 `&`、`(`、`)`）、解释器从不可见来源取码（`curl x | bash`、`bash < script`）、引号或转义未闭合。

逐节点分类覆盖的命令族：

- 安全只读命令（cat、ls、rg、grep 等）→ 按路径作用域产生 `read-*`；无路径参数时正面担保（无标签，自动放行）；
- 网络命令（curl、wget）→ 无上传且 GET/HEAD 为 `network-fetch`，有上传或非 GET/HEAD 为 `network-send`；
- git：status/diff/log/show 正面担保；pull/fetch/clone 为 `network-fetch`；push 为 `network-send`；其余弃权；
- 包管理器：npm 按子命令细粒度分类（见 3.2-3.4），其余（bun、pnpm、yarn、cargo、pip 等）为 `network-fetch` 加工作区 `edit-*`；
- 文件操作（rm、mv、cp、mkdir）→ 按目标作用域产生 `edit-*`；递归删除系统根或盘符根声称 `violation`；
- 系统级更改命令（sudo、systemctl、chmod 等）→ `system-change`。

任一节点无法分类时整体弃权（→ `unknown` → 人工）。

### 3.2 npm 安装与更新

以下子命令产生 `network-fetch` 和安装目标对应的 `edit-*`：

```text
npm install
npm i
npm ci
npm update
npm up
```

默认安装目标按 cwd 推导，因此在工作区执行：

```bash
npm install
```

会产生：

```text
network-fetch
edit-workspace
```

分类器支持两种静态 `--prefix` 写法：

```bash
npm --prefix /path/to/project install
npm --prefix=/path/to/project install
```

写入标签按 prefix 解析后的目标位置确定：工作区内为 `edit-workspace`，用户目录内为 `edit-home`，两者之外为 `edit-system`。

### 3.3 npm 卸载

以下子命令产生安装目标对应的 `edit-*`，不额外断言网络获取：

```text
npm uninstall
npm remove
npm rm
npm un
npm unlink
```

### 3.4 npm 发布

```bash
npm publish
```

产生：

```text
network-send
```

当前实现不进一步分析发布包内容，也不从该命令推导具体读取路径。

### 3.5 尚未覆盖的 npm 行为

当前未覆盖的典型行为包括：

- `npm run`、`npm exec`、`npx`；
- `npm config`、`npm cache`、登录和登出；
- 全局安装参数及 npm 配置共同决定的真实全局目录；
- workspace 选择参数；
- registry、认证和脚本执行等更细粒度副作用；
- 动态 prefix 或依赖环境变量才能确定的目标。

这些输入不会由内置 Bash 分类器猜测标签。若没有其他分类器作出断言，最终结果为 `unknown`；用户或业务方可以注册掌握具体语义的自定义分类器补齐。

---

## 4. 自定义分类器与替换

分类器 ID 使用 `namespace/name@version` 形式。注册表支持两种组合方式：

- 使用不同 ID 注册：与现有分类器共同运行，claims 取并集；
- 使用相同 ID 注册用户分类器：完全替换该 ID 的现有分类器，被替换项不再运行。

例如，业务方可以使用独立 ID 补充内部 npm 脚本语义，也可以使用 `builtin/bash@1` 作为 ID 完全替换当前 Bash 分类器。

当前代码已经实现分类器注册、并集合并、按 ID 替换和异常按弃权处理。**应用级 TypeScript 分类器目录的自动加载与管理界面尚未接通**；现阶段自定义分类器需要由应用集成代码显式注册。

---

## 5. 当前实现边界

以下能力属于权限系统规格，但尚未在当前内置分类器中完整实现：

- PowerShell、cmd 的独立白名单文法前端；
- Bash 结构性拒绝清单之外的复杂控制结构（子 Shell、here-document 等）逐节点解析；
- 更广的命令语义（make、docker、npx 等）；
- 用户可配置的敏感路径列表；
- custom 策略文件加载；
- 应用级自定义分类器发现、启停和加载错误界面；
- 分类器执行超时；

以下能力已落地：

- Bash 解析器（命令拆分、结构性拒绝、动态语法与不可见来源判 unknown）；
- 安全只读/网络/git/包管理器/文件操作/系统更改命令族转译为标签；
- 独立轮转的 `permission-audit.jsonl` 审计文件。

这些边界意味着当前版本优先保证四层框架、全部基础工具接入和已有分类规则可验证，而不宣称已经覆盖《权限系统实现规格》中的全部命令语义。内置分类器明确弃权且没有其他分类器断言的调用按 `unknown` 处理；复合 Shell 语法的完整解析仍是后续必须补齐的能力。
