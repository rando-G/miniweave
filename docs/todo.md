# MiniWeave 改造 TODO

> **给下一个 agent 的交接说明**
>
> 1. 先读 [`summary.md`](./summary.md) 的最新一天，了解"已做了什么、为什么这么做"。
> 2. 完成任意一项后，把下面对应的 `- [ ]` 改成 `- [x]`，并在 `summary.md` 追加当天记录。
> 3. 每次改动后跑：`npm run check && npm run lint && npm test`。
> 4. 注意：`test/run-tests.mjs` 现在会把 `MINI_CODE_HOME` 指向临时目录，避免测试删掉真实会话历史。不要在测试里手动把 `MINI_CODE_HOME` 指回 `~/.mini-code`。
> 5. 本目录（`docs/`）同时是 GitHub Pages 站点目录，放 `.md` 不影响页面。

当前状态一句话：**RSI 引擎 MVP 已完成、有测试、有离线 demo；MiniWeave-Bench、运行时接线、GUI 还没做。**

---

## 2026-10-15 — RSI 引擎 MVP

### 完成
- [x] 确定 RSI 调研结论：主轴抄 `pi-Dream-RSI`（TS/MIT，工程骨架）+ `Darwin Gödel Machine`（外层归档算法），Python 框架只作蓝本不嵌入。
- [x] 新建 `src/rsi/` 模块并保持依赖注入（core 不依赖模型/网络，可单测）。
- [x] `src/rsi/types.ts`：`CandidatePatch` / `ScoreResult` / `Scorer` / `Mutator` / `CampaignLimits` / `TreeNode` / `EvaluationRecord` / `RsiEvent` 等契约。
- [x] `src/rsi/budget.ts`：`CampaignBudget`，硬预算（cycles / agentStarts / evaluatorRuns / deadline），可注入时钟，先检查后消费。
- [x] `src/rsi/tree.ts`：`DiscoveryTree`（root + branch/attempt、best、frontier、lineage、round-trip）。
- [x] `src/rsi/archive.ts`：append-only JSONL 血缘日志（照 `session.ts` 的容错读取）。
- [x] `src/rsi/candidate.ts`：内容指纹、去重/排序、`**` glob 范围校验、安全写盘（拒绝 `..` 与绝对路径）。
- [x] `src/rsi/workspace.ts`：`git worktree` 沙箱；候选各自独立 worktree，接受项提交到 `rsi/<id>` 分支，**从不碰用户工作区/当前分支**。
- [x] `src/rsi/scorer.ts`：`createCommandScorer`，冻结的评测契约（stdout 或 `$WEAVE_SCORE_FILE`），带契约指纹、超时、进程树 kill。
- [x] `src/rsi/mutator.ts`：`StaticMutator` + 容错 JSON 解析（代码块/噪声输出）。
- [x] `src/rsi/model-mutator.ts`：`ModelMutator`，用现有 `ModelAdapter` 产候选，含 prompt 构造。
- [x] `src/rsi/campaign.ts`：`RsiCampaign` 主循环（baseline 两次一致性检查 → 每轮提案 → 隔离评测 → 超过 `minimumGain` 才接受 → plateau/预算/超时/abort 停止）。
- [x] `src/rsi/index.ts`：统一导出。
- [x] 测试：`test/rsi.test.ts`（15 例）+ `test/rsi-campaign.test.ts`（端到端，含接受/拒绝/去重/越权跳过/分支提交验证）。
- [x] `bench/rsi-demo.ts` + `npm run bench:rsi`：离线可跑，打印完整 discovery tree。
- [x] 修复 `test/run-tests.mjs`：默认隔离 `MINI_CODE_HOME`，消除 `rm -rf ~/.mini-code/projects` 隐患。
- [x] 全部验证通过：`tsc --noEmit`、`eslint src test`、`npm test`（323 pass / 0 fail）。

### 下午续：让 RSI 在 miniweave 自身上真的跑通
- [x] 抽出冻结的适应度模块 `bench/token-fit.ts`（14 条覆盖全部 role 的样本 + MAPE 计算），样本与参照 tokenizer 都在可变范围之外。
- [x] `bench/rsi-token-score.ts`：评分脚本，从 `$WEAVE_WORKSPACE` 按绝对路径动态加载候选的 `heuristic-counter.ts`，分数 = `100 - MAPE`。
- [x] `bench/rsi-self.ts` + `npm run bench:rsi:self`：可变面 = `src/token/heuristic-counter.ts` 的 `CHARS_PER_TOKEN` 比值表，mutator = 无先验的局部搜索（逐 role ±step，步长递减）。
- [x] `createCommandScorer` 增加 `cwd` 选项（scorer 需要从主仓库解析依赖，候选文件通过 `$WEAVE_WORKSPACE` 读取）。
- [x] campaign 把"候选评测失败"当作可恢复证据（新增 `candidate_failed` 事件与 `EvaluationRecord.error`），坏候选不会中止整个 campaign。
- [x] 测试补充：scorer 的 `cwd` 覆盖、失败候选被记录且 campaign 继续。`npm test` 325 pass / 0 fail。
- [x] 实测结果（脚本 mutator）：`npm run bench:rsi:self` 把启发式计数器的 MAPE 从 **48.81% 降到 35.53%**，提交在分支 `rsi/ec51accb`（当时统计 17 项，后被修复为每轮仅 1 项，见下）。

### 傍晩：模型驱动（真正的"模型改自己 harness"）
- [x] `bench/rsi-model.ts` + `npm run bench:rsi:model`：用真实 `ModelMutator` 替代脚本 mutator，可变面与评分与 self 版一致。
- [x] campaign 新增 `seedFiles`：模型在第 1 轮能看到基线源码（否则无从下手）；accepted 后文件集改为 merge 而非覆盖。
- [x] champion 分支改为懒创建（没接受任何改动就不留空分支）。
- [x] `ModelMutator` 容错：模型输出无法解析时返回空提案并回调 `onParseError`，不会中止 campaign。
- [x] mock 管道验证：`MINI_CODE_MODEL_MODE=mock npm run bench:rsi:model` 可离线跑通且不建分支。
- [x] 实测结果（deepseek-flash）：模型自主提出 **CJK 感知计数**（Hiragana/Katakana/Hangul + 扩展 A–I），MAPE **48.81% → 37.98%**，分支 `rsi/81884186`（修复前引擎，需重跑）。

### 修复：轮内覆盖 bug
- [x] 定位：同一轮内多个整文件候选被接受时，后者会静默覆盖前者的改动，导致 `acceptedCount` 虚高、mutator 基座过期。
- [x] 修复：`src/rsi/campaign.ts` 改为**每轮只晋升一个最优候选**（所有候选对同一 cycle-start champion 评分）。
- [x] 回归测试：一轮内两个都优于 baseline 的候选，只晋升分高者，且下一轮基座是晋升者。
- [x] 重跑 self：`accepted` 17 → **12**，最终 MAPE 仍 **35.53%**，新分支 `rsi/8a10e615`。
- [ ] 用修好的引擎重跑一次 `bench:rsi:model`（会产生新分支，需 API 调用）。

### 修复：TUI 鼠标选择坐标
- [x] `src/tty-app.ts`：`transcriptBodyStartY` 从写死 `+4` 改为按实际 frame 推导（新增 `resolveTranscriptBodyStartY`）。
- [x] 水平偏移 `screenX - 3` → `screenX - 1`（session-feed 面板无边框）。
- [x] 回归测试 `test/transcript-selection-offset.test.ts`。

### 修复：IME 预编辑不在输入框内
- [x] `src/tui/input.ts`：新增 `inputPromptCaretWidth`（显示宽度口径，含 CJK）。
- [x] `src/tty-app.ts`：新增 `placeInputCursor`，每帧后把真实光标移到输入框内并 `showCursor()`。
- [x] 回归测试 `test/input-caret.test.ts`。
- [ ] 审批面板 feedback 输入的光标定位（同类问题，未处理）。
- [x] 把光标定位与整帧合并为**一次 stdout 写入**（`renderTerminalFrame(frame, cursor?)`），消除 IME 锚到底部的闪烁窗口。

### 新增：全局命令 `weave`
- [x] 新增跨平台 `bin/weave.mjs`；`package.json` 的 `bin` 指向它；`bin/weave` 保留为薄封装。
- [x] `src/install.ts` 跨平台修复（`path.delimiter`、Windows `.cmd` 启动器）。
- [x] 执行 `npm link` 并验证 bash / cmd / PowerShell 均可 `weave`，且以调用者目录为工作区。

### 品牌统一 minicode → weave / MiniWeave
- [x] 用户可见文案：CLI usage / banner / 输入框提示符（`weave> `）/ 审批提示 / resume 提示 / `/status` / init 模板 / skills・MCP 提示 / web UA。
- [x] 模型提示词 `src/prompt.ts` 首行改为 MiniWeave。
- [x] 内部类型 `MiniCodeSettings` → `MiniWeaveSettings`。
- [x] 数据目录默认 `~/.weave`，保留 `~/.mini-code` 回退（不丢配置）；项目目录 `.weave/` 兼容 `.mini-code/`。
- [x] 更新 README、`docs/summary.md`。

### 当天未完成（滚动到下一工作日）
- [ ] 把 RSI 接进运行时：新增 `mode: 'rsi'` / `/rsi` 命令，仿 `GoalController` 写 `RsiController`。
- [ ] 为 RSI 提供 `read_harness` / `propose_mutation` / `evaluate_candidate` 工具，并接入 `PermissionManager` 人工确认。
- [ ] 把 `src/plugin/` 接进 `src/index.ts`，注册 `RsiService` / `BenchService` / `TraceService`。

---

## Backlog（未排期）

### P0 — 让 RSI 真的能自改 harness
- [x] 一个真实、离线、可复现的适应度来源：token 计数器 MAPE（`bench/token-fit.ts` + `bench/rsi-token-score.ts`）。
- [x] 在 miniweave 自身上跑通一次有记录的自改实验（可变面 = `CHARS_PER_TOKEN`，脚本 mutator）。
- [x] 用真实 `ModelMutator` 替代脚本 mutator，让模型自己提候选（已完成）。
- [ ] **scorer 需要复合目标**：当前只测 token MAPE，候选可能破坏其他行为；应把 `npm test`（或其他 bench）纳入同一个 scorer。
- [ ] **合并前校验**：接受项应在对应分支上跑一遍完整 `npm test`（worktree 没有 `node_modules`，需 junction/符号链接方案）。
- [ ] 建 `src/bench/`：MiniWeave-Bench（多类型任务集 + 判分），作为通用适应度来源，且必须在可变范围之外只读。
- [ ] 候选隔离补强：沙箱网络关闭、资源上限（内存/时间）、`bench/` 与 `test/` 完整性校验。
- [ ] "显式运行预算"补齐：工具调用数上限 + 整轮总超时（当前 `maxSteps` 只对 goal/loop 生效，工具数/总超时没有实现）。

### P1 — 差异化与消融
- [ ] replay：用历史 discovery tree 离线重放，比较不同探索策略（Dream-RSI 的差异点）。
- [ ] 消融实验：`Fixed policy` vs `replay-evolved policy`，产出 acceptance rate / 调用数对比。
- [ ] 探索策略 `policy.ts` 作为真实 TS 模块被 RSI 自己重写。

### P2 — GUI（仿 Codex）
- [ ] 抽 `AgentEvent` / `Command` 协议（`src/protocol/`），让 TUI 与 GUI 共用。
- [ ] Node 内置 `http` + SSE 服务端；权限流用带 correlation id 的 pending-request map。
- [ ] 前端三栏：sessions/Goal/Plan/RSI 状态 | transcript + 工具卡片 + 审批卡 | diff + 文件树。
- [ ] `npm run gui` 入口；复用 `tui/*` 已有的纯渲染数据结构。

### P3 — 文档与整理
- [x] 重写 `README.md`（围绕亮点，见 2026-10-15 记录），roadmap 勾选已更新。
- [x] 删除已被 README 取代的上游文档：`ARCHITECTURE*` / `ROADMAP*` / `USAGE*` / `CLAUDE_CODE_PATTERNS*` / `CONTRIBUTING*` / `docs/index.html`（保留 `docs/logo.svg`，README 在用）。
