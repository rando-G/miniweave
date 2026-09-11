# MiniWeave

> A plugin-based Coding Agent Harness. Weave Model / Tool / Session / Permission / Context into replaceable plugins, then quantify each mechanism's value with benchmarks and ablation studies.

**MiniWeave** 是一个插件化重构的 Coding Agent Harness：在 [MiniCode](https://github.com/LiuMengxuan04/MiniCode)（MIT）基础上，把 Agent Loop、Model、Tool、Session、Permission、Context Manager 抽象为可替换插件，并用自建 Benchmark + 消融实验量化每个 Harness 机制对 Agent 执行效果的影响。

- **技术栈**：TypeScript · Node.js · Anthropic API · JSONL · git worktree
- **定位**：轻量、可读、可扩展、可量化 —— 面向学习与面试的 Agent Runtime

## 为什么叫 MiniWeave

- **weave（编织）**：把模型、工具、会话、权限、上下文这些"线"，织成一个可运行的 harness。
- **mini**：继承 MiniCode 的轻量定位，也诚实标明血缘。

## 与上游 MiniCode 的关系

本项目基于 [LiuMengxuan04/MiniCode](https://github.com/LiuMengxuan04/MiniCode) 的 commit [`4041375`](https://github.com/LiuMengxuan04/MiniCode/commit/40413758cc12892528d31c85edbe53e97a25a88d)（MIT License），原始版权声明保留在 [LICENSE](./LICENSE)。

MiniWeave 在 MiniCode 之上做的主要改造（进行中）：

| 方向 | 上游 MiniCode 现状 | MiniWeave 目标 |
|---|---|---|
| 架构 | 单体重构，扩展点仅 ToolRegistry / ModelAdapter / MCP | 统一 Plugin + Service + Registry + DI + 生命周期 |
| 多 Agent | 3 个只读 worker、纯内存、共享模型 | worktree 隔离的可写并行 Agent + DAG 调度 + 预算 |
| 上下文 | 字符/Token 启发式估算 + 四级压缩 | 真实 tokenizer + repo-map 检索 + 缓存 + 压缩消融 |
| 评测 | 无 | MiniWeave-Bench + 自动化 Evaluator + 消融实验 |

## 架构目标

```text
CLI ──► Runtime（组装插件）
          │
          ├─ Model Plugin ──────── Anthropic / 未来多 provider
          ├─ Tools Plugin ──────── 文件 / Shell / MCP / Skills
          ├─ Session Plugin ────── JSONL 持久化 + 恢复 + fork
          ├─ Permission Plugin ─── 路径 / 命令 / 编辑授权
          ├─ Context Manager ───── 构建 + 压缩模型上下文
          ├─ Event Bus ─────────── 生命周期事件 + trace
          └─ Agent Loop ────────── Model → Tool → Result 状态机
```

Loop 只依赖 Service 接口，不关心具体模型 / 工具实现，因此插件可独立替换而无需改动执行循环。

## Roadmap

- [x] 初始导入 MiniCode 并重命名为 MiniWeave
- [ ] 插件化 Runtime 骨架（MiniPlugin / ServiceRegistry / MiniContext）
- [ ] 多 Agent 并行调度（worktree 隔离 + DAG + 预算控制）
- [ ] 上下文与成本优化（真实 tokenizer + repo-map 检索 + prompt 缓存）
- [ ] MiniWeave-Bench（多类型任务 + 自动化判分）
- [ ] 消融实验：Baseline / +Context / +Prompt Optimizer / +Multi-Agent / Full

## 快速开始

```bash
npm install

# 配置模型凭据（当前与上游 MiniCode 兼容）
export ANTHROPIC_MODEL=claude-sonnet-4
export ANTHROPIC_API_KEY=sk-ant-...      # 或 ANTHROPIC_AUTH_TOKEN

npm run dev        # 交互式运行
./bin/weave        # 等价入口
npm test           # 跑测试
```

> 注：内部命名（`~/.mini-code` 数据目录、`MINI_CODE_*` 常量）暂与上游一致，后续统一为 MiniWeave。

## 目录结构

```text
src/
├─ agent-loop.ts          # Model → Tool → Result 多轮状态推进
├─ tool.ts                # 工具注册、校验、执行
├─ tools/                 # 文件 / Shell / MCP / Skills 等工具
├─ session.ts             # JSONL 会话持久化
├─ permissions.ts         # 权限与危险命令分类
├─ compact/               # 上下文压缩（snip / collapse / micro / auto）
├─ agents/                # 多 Agent MVP
├─ tui/                   # 终端 UI
└─ ...
test/                     # 31 个测试文件，npm test 运行
```

## License

[MIT](./LICENSE)，含 MiniCode 原始版权声明。
