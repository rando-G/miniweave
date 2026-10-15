# MiniWeave

<p align="center">
  <img src="./docs/logo.svg" alt="MiniWeave" width="150" />
</p>

<p align="center">
  <b>把 Model / Tool / Session / Permission / Context 编织成一个可替换、可度量、能自我改进的 Coding Agent Harness。</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" />
  <img src="https://img.shields.io/badge/tests-340%20passing-brightgreen.svg" alt="Tests: 340 passing" />
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6.svg" alt="TypeScript 5.x" />
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933.svg" alt="Node.js >= 22" />
  <img src="https://img.shields.io/badge/deps-2-brightgreen.svg" alt="2 runtime dependencies" />
</p>

<p align="center">
  技术栈：TypeScript · Node.js · Anthropic 兼容 API（Claude / DeepSeek）· JSONL · git worktree · SSE-ready
</p>

---

## 这是什么

MiniWeave 是一个**插件化重构的 Coding Agent Harness**。它把 Agent 运行时里那些通常写死在一起的机制，拆成可以单独替换、单独测量的部件：

```
Model · Tool · Session · Permission · Context Manager
```

然后做两件很多同类项目不做的事：

1. **可度量** —— 每个机制的价值都用 benchmark 量化，而不是"感觉更好了"；
2. **可自我改进（RSI）** —— agent 能在隔离沙箱里修改自己的 harness 代码，用冻结的评测器打分，只保留经过验证的改进。

面向的场景：学习 Agent Runtime 的内部结构、做 Harness 机制的消融实验、以及研究"让 agent 改自己代码"这一类递归自我改进（Recursive Self-Improvement）问题。

---

## 亮点

| 亮点 | 说明 |
|---|---|
| 🧬 **RSI 引擎** | `src/rsi/`：有界 campaign + git worktree 隔离 + 冻结评测契约 + discovery tree + 血缘归档，**一次只晋升一个最优候选**，模型可以真的改写自己的 harness 代码 |
| 🧩 **插件化 Runtime** | `MiniPlugin` / `ServiceRegistry` / `MiniContext` / `PluginRegistry`，Kahn 拓扑排序解析依赖，setup 失败自动回滚 |
| 🔢 **可插拔 Token 记账** | `heuristic`（零依赖）与 Anthropic 官方 BPE tokenizer 可切换；provider 返回的 `usage` 为唯一真值 |
| 🗜️ **四级上下文压缩** | microcompact → snipCompact → context-collapse → autoCompact；超长工具输出落盘，只留预览 |
| 🤖 **多 Agent** | 只读 worker：独立消息历史、受限工具集、并发上限、可取消 |
| 🎯 **Goal / Plan / Loop** | 自治执行的三种原语：目标 + 完成标准、todo 计划、定时循环，全部带预算与暂停语义 |
| 🖥️ **手写 TUI** | 全屏 ANSI 渲染、鼠标选词、CJK 友好、输入法（IME）光标定位 |
| 💾 **会话与记忆** | JSONL 追加式持久化、parentUuid 树、resume / fork、30 天过期清理；分层指令文件加载 |
| 🔌 **可扩展** | 内置工具集 + MCP（stdio / streamable-http）+ Skills（`.weave/skills`、`.claude/skills` 兼容） |
| ✅ **测试与评测** | 340 个测试；token 准确度 benchmark；RSI 离线 / 模型驱动两套实验入口 |

---

## 架构

```text
CLI (weave)
  │
  ▼
Runtime ── 组装插件 / 服务
  │
  ├─ Model Plugin ──────── Anthropic 兼容 API
  ├─ Tools Plugin ──────── 文件 / Shell / MCP / Skills
  ├─ Session Plugin ────── JSONL 持久化 + 恢复 + fork
  ├─ Permission Plugin ─── 路径 / 命令 / 编辑授权
  ├─ Context Manager ───── 构建 + 压缩模型上下文
  └─ Agent Loop ────────── Model → Tool → Result 状态机
        │
        └─ RSI Campaign ── 提案 → 隔离评测 → 择优晋升（改的就是上面这些机制）
```

Agent Loop 只依赖 Service 接口，不关心具体模型 / 工具实现；插件可以独立替换，执行循环不改一行。

> 状态：`src/plugin/` 的插件骨架与测试已完成，运行时装配（把 `index.ts` 的手工构造切换到插件注册）仍在进行中 —— roadmap 里如实标注。

---

## RSI：让 Agent 改自己的 Harness

这是 MiniWeave 最有意思的部分。一次 campaign 的流程：

```text
         ┌──────────────────────────────────────────────┐
         │  baseline：对未修改的 harness 评测两次（一致性检查） │
         └───────────────────────┬──────────────────────┘
                                 ▼
   ┌──────────────┐   提案候选    ┌───────────────────────────┐
   │  Mutator      │ ───────────▶ │  每个候选一个 git worktree   │
   │ (模型 / 脚本)  │              │  写入候选 → 跑冻结的 Scorer  │
   └──────────────┘              └─────────────┬─────────────┘
          ▲                                      │ 分数
          │                                      ▼
          │                       ┌───────────────────────────┐
          └──── 冠军作为下一轮基座 ── │  每轮只晋升"最优且超过阈值"的一个 │
                                    └─────────────┬─────────────┘
                                                  ▼
                              接受项 commit 到 rsi/<id> 分支（不碰你的工作区）
```

设计要点（也是从公开 RSI 工作里学到的教训）：

- **变的是代码，不只是 prompt**：候选是完整的 harness 文件改写。
- **评测器在可变范围之外**：样本、参照 tokenizer、评分脚本都属于冻结契约，候选无法"移动靶子"。
- **隔离与可回退**：每个候选在自己的 `git worktree` 里评测，接受项只落在 `rsi/<id>` 分支。
- **有界**：cycle / 评测次数 / agent 调用 / wall-clock / plateau 五重预算，先检查后消费。
- **一次只晋升一个**：避免同一轮里后一个整文件改写静默覆盖前一个已接受改动。
- **坏候选是普通证据**：编译失败 / 评测异常不会中止 campaign。

### 实测结果

目标：让启发式 token 计数器更接近 Anthropic 官方 tokenizer（适应度 = `100 − MAPE`，越高越好）。

```bash
npm run bench:rsi:self     # 离线，脚本 mutator，无网络
npm run bench:rsi:model    # 模型驱动，候选由 LLM 提出
npm run bench:rsi          # 合成 demo，看引擎机制
```

| 方式 | 结果 |
|---|---|
| 脚本局部搜索 | MAPE **48.81% → 35.53%**（17 → 12 次晋升） |
| 模型驱动（deepseek-flash） | MAPE **48.81% → 37.98%**，模型自己写出了 **CJK 感知计数**（Hiragana/Katakana/Hangul + 扩展 A–I） |

模型那次产出的不是调常量，而是一段完整的实现 —— 它成了这段 harness 代码的作者。

---

## Token 记账（可插拔）

上下文用量既决定压缩阈值，也决定成本，所以计数策略是可插拔的 `TokenCounter`：

| 实现 | 说明 |
|---|---|
| `heuristic` | 无依赖的字符 / 常数估算（默认，确定性，现已支持 CJK 加权） |
| `anthropic` | Anthropic 官方 BPE tokenizer（可选依赖 `@anthropic-ai/tokenizer`） |
| `auto` | 装了真 tokenizer 就用它，否则回退启发式 |

```bash
export MINIWEAVE_TOKEN_COUNTER=anthropic   # heuristic | anthropic | auto
```

精确总量以 provider 返回的 `usage` 为准；tokenizer 用于估算 usage 之后的尾部消息，以及 provider 不返回 usage 时兜底。

### 基准

```bash
npm run bench:tokens        # 离线：启发式 vs 官方 tokenizer
npm run bench:tokens:live   # 用 Claude 真实 input_tokens 校准（少量请求）
```

| 计数器 | MAPE |
|---|---|
| 字符启发式 | 50.4% |
| Anthropic 官方 tokenizer | **6.4%** |

> 参照为 Claude 原始 `input_tokens`，含少量请求固定开销，因此 tokenizer 误差是保守上界。

---

## 快速开始

```bash
git clone git@github.com:rando-G/miniweave.git
cd miniweave
npm install

# 配置模型凭据（任何兼容 Anthropic Messages API 的端点都行，含 DeepSeek）
export MINIWEAVE_BASE_URL=https://api.deepseek.com/anthropic
export MINIWEAVE_AUTH_TOKEN=sk-...
export MINIWEAVE_MODEL=deepseek-flash

npm run dev        # 在仓库内交互式运行
weave              # 全局命令，见下
npm test           # 跑测试
```

### 全局命令（任意目录使用）

```bash
npm link           # 把 bin/weave 注册到 npm 全局 bin（已在 PATH 上）
weave              # 之后在任意目录直接启动，以当前目录为工作区
```

`bin/weave.mjs` 是跨平台 Node 启动器，npm 会在 Windows 上生成 `weave.cmd` / `weave.ps1` shim，bash / cmd / PowerShell 都能直接用。也可以 `npm run install-local` 写一个启动器到 `~/.local/bin`。

### 配置优先级

从高到低：

1. `MINIWEAVE_*` 环境变量（专属命名空间）
2. `MINI_CODE_*` 环境变量（遗留别名）
3. `~/.weave/settings.json`
4. `ANTHROPIC_*` 环境变量
5. `~/.claude/settings.json`

> **为什么设置文件排在 `ANTHROPIC_*` 之前？** 因为 `ANTHROPIC_*` 常被其它 Anthropic 兼容工具（pi、Claude Code）导出，如果让它覆盖本工具配置，就会出现"模型来自 settings.json、凭据来自别人"的脑裂。启动时会检测这种混合来源并打印警告，`/status` 能看到每个值实际来自哪里。

> 数据目录默认 `~/.weave`；若检测到旧的 `~/.mini-code/` 且 `~/.weave/` 不存在，会继续沿用旧目录，升级不丢配置与会话。项目内配置目录默认 `.weave/`，同样兼容 `.mini-code/`。

---

## 目录结构

```text
src/
├─ rsi/                   # 递归自我改进引擎（campaign / tree / archive / scorer / worktree）
├─ plugin/                # 插件化 Runtime（MiniPlugin / ServiceRegistry / PluginRegistry）
├─ token/                 # 可插拔 Token 计数（heuristic / anthropic tokenizer）
├─ agent-loop.ts          # Model → Tool → Result 多轮状态推进
├─ tool.ts                # 工具注册、校验、执行
├─ tools/                 # 文件 / Shell / MCP / Skills 等工具
├─ session.ts             # JSONL 会话持久化 + resume / fork
├─ permissions.ts         # 路径 / 命令 / 编辑授权
├─ compact/               # 上下文压缩（snip / collapse / micro / auto）
├─ agents/                # 多 Agent（只读 worker）
├─ goal/ plan/ loop/      # 自治执行原语
├─ tui/                   # 终端 UI 组件
└─ tty-app.ts             # TUI 主循环
test/                     # 340 个测试
bench/                    # 评测脚本（token 准确度 / RSI 自改实验）
docs/                     # 进度文档（todo.md / summary.md）
```

---

## Roadmap

- [x] 可插拔 Token 记账（官方 BPE tokenizer + 基准测量）
- [x] 会话持久化与恢复（JSONL + parentUuid 树 + fork）
- [x] 上下文压缩（snip / collapse / micro / auto）
- [x] 分层记忆加载 + `/init` 项目引导
- [x] RSI 引擎（worktree 隔离 + 冻结评测 + discovery tree + 血缘归档）
- [x] RSI 离线与模型驱动两条实验路径
- [x] 全局 `weave` 命令（跨平台）
- [ ] 插件化 Runtime 接入生产装配（骨架与测试已完成）
- [ ] MiniWeave-Bench：多类型任务集 + 自动化判分（作为通用适应度）
- [ ] 复合适应度（MAPE + 测试通过率），避免候选过拟合单一指标
- [ ] replay：用历史 discovery tree 离线进化探索策略
- [ ] 消融实验：Baseline / +Context / +Multi-Agent / +RSI / Full
- [ ] GUI（仿 Codex 三栏：transcript + 工具卡片 + diff）

---

## License

[MIT](./LICENSE)。
