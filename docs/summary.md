# MiniWeave 改造进度

> 每天追加一节，最新在最上面。任务清单见 [`todo.md`](./todo.md)。
>
> 追加模板：
>
> ```markdown
> ## YYYY-MM-DD
> ### 目标
> ### 做了什么
> ### 关键决策
> ### 验证结果
> ### 遗留问题 / 下一步
> ```

---

## 2026-10-15

### 目标

给 MiniWeave 加入 RSI（Recursive Self-Improvement）能力：让 harness 能被候选补丁修改，再在隔离环境里用冻结的评测器打分，只保留超过阈值的改进；同时为后续 GUI 打地基。可变面按用户要求定为 **harness 代码**。

### 调研结论（决定"抄谁"）

- **pi-Dream-RSI**（`juanmackie/pi-Dream-RSI`，TypeScript/MIT，2026-09 新建、单人）：star 只有 13，但实测克隆后 `tsc` 通过、`node --test` **195/195 通过**，CI 覆盖 ubuntu+windows，测试覆盖崩溃恢复/重放/补丁冲突等难点；其 `agent/runner.ts` 通过子进程 + 可配置 `AgentConfig.command` 驱动任意 CLI agent，`runShellCommand` 跑 scorer，宿主耦合只集中在 `index.ts`。→ 判定：**方法新、生态不成熟，但工程质量和可移植性足以当"工程骨架"抄**。
- **Darwin Gödel Machine**（`jennyzzt/dgm`，Python/Apache-2.0，2.4k★）：改自身代码 + benchmark 验证 + archive 父代选择的成熟算法蓝本。→ **抄外层算法，不嵌入**。
- **Gödel Agent**（MIT）：`read_logic` / `write_logic` / `evaluate_on_task` 自指动作蓝本。
- Python 系（OpenEvolve、ShinkaEvolve、STOP、ADAS）只作参考，不进入 Node 代码库；`tangle-network/gepa-ts` 许可为 NOASSERTION，避免使用。
- 关键判断：**RSI 的前置条件是"可复现的适应度信号"，所以 Bench 必须先行**；本次先交付不依赖模型/网络的引擎内核，Bench 与真实自改为下一步。

### 做了什么

新增 `src/rsi/`（依赖注入、无网络、可单测）：

| 文件 | 职责 |
|---|---|
| `types.ts` | `CandidatePatch` / `ScoreResult` / `Scorer` / `Mutator` / `CampaignLimits` / `TreeNode` / `EvaluationRecord` / `RsiEvent` 契约 |
| `budget.ts` | `CampaignBudget`：cycles / agentStarts / evaluatorRuns / deadline，可注入时钟，先检查后消费 |
| `tree.ts` | `DiscoveryTree`：root + branch/attempt、best、frontier、lineage、round-trip |
| `archive.ts` | append-only JSONL 血缘日志，容错读取 |
| `candidate.ts` | 内容指纹、按路径去重排序、`**` glob 范围校验、安全写盘 |
| `workspace.ts` | `git worktree` 沙箱；接受项提交到 `rsi/<id>` 分支 |
| `scorer.ts` | `createCommandScorer`：冻结的评测契约、契约指纹、超时、进程树 kill |
| `mutator.ts` | `StaticMutator` + 容错 JSON 解析 |
| `model-mutator.ts` | `ModelMutator`：用现有 `ModelAdapter` 产候选 |
| `campaign.ts` | `RsiCampaign` 主循环 |

配套：
- `test/rsi.test.ts`（15 例）：预算、树、指纹/glob/写盘、JSON 解析、scorer 四种契约路径。
- `test/rsi-campaign.test.ts`：端到端，覆盖 accept / reject / 重复去重 / 越权跳过 / 分支提交 / 工作区不被污染。
- `bench/rsi-demo.ts` + `npm run bench:rsi`：离线 demo，打印完整 discovery tree。
- 修 `test/run-tests.mjs`：默认把 `MINI_CODE_HOME` 指向临时目录。

### 关键决策

1. **候选用"整文件内容"而不是 diff**：评测器把文件内容原样写进隔离 worktree，避免 diff 解析/行号漂移，也让候选必须自洽。对应 pi-Dream-RSI 的 `CandidatePatch`。
2. **接受项提交到 `rsi/<id>` 分支，而不是改用户工作区**：用户当前分支和工作树始终保持不变，事后可 `git log/diff/merge`。这比 pi-Dream-RSI 直接 `apply` 更保守、更适合教学项目。
3. **评测器必须在可变范围之外**：`createCommandScorer` 的 contract 由 campaign 定义，scorer 不应落在被候选修改的文件里；`mutableFiles` glob 之外的候选直接丢弃并记事件。
4. **同轮内候选按"当前 champion"串行比较**：于是 1→2→3→4 会连续接受，champion 复利前进；这是有意的贪心策略，已在集成测试里固化。
5. **预算先检查后消费**：保证不会超支一次昂贵评测；deadline 用注入时钟以便确定性测试。
6. **不引入任何新依赖**：只用 node 内置 + 现有 `zod`，保持项目轻量。

### 验证结果

```
npx tsc --noEmit        ✅ 0 error
npm run lint            ✅ 0 error / 0 warning
npm test                ✅ 323 pass / 0 fail（含新增 16 例 RSI 测试）
npm run bench:rsi       ✅ baseline 1 -> best 7，含 ACCEPT / reject / skip / 越权跳过
```

### 下午续：离线 RSI 在 miniweave 自身上跑通

**目标**：让用户能真的看到 RSI 效果，而不是只有合成 demo。思路：miniweave 自己就有一个全离线、可量化的改进目标 —— 启发式 token 计数器的 `CHARS_PER_TOKEN` 比值表，适应度用对官方 tokenizer 的 MAPE。

**新增**：

| 文件 | 职责 |
|---|---|
| `bench/token-fit.ts` | 冻结的适应度材料：14 条覆盖全部 role 的样本 + MAPE 计算 |
| `bench/rsi-token-score.ts` | 评分脚本：从 `$WEAVE_WORKSPACE` 按绝对路径加载候选计数器，输出 `{score: 100-MAPE}` |
| `bench/rsi-self.ts` | `npm run bench:rsi:self`：在 miniweave 仓库上跑 campaign |

**引擎加固**：
- `createCommandScorer` 增加 `cwd` 选项，让 scorer 从主仓库启动（这样它的依赖能解析），候选文件一律通过 `$WEAVE_WORKSPACE` 读取。
- campaign 把"候选评测失败"记为**可恢复证据**：新增 `candidate_failed` 事件与 `EvaluationRecord.error`，坏候选被记录但不会中止 campaign（对应 pi-Dream-RSI "编译错误是普通证据"的做法）。

**关键决策**：
1. **mutator 没有 oracle 权限**：它只能看到当前 champion 的比值表和历史分数，看不到参照 token 数。它做的是无先验局部搜索（逐 role ±step、步长递减、窗口轮转）。因此增益来自 campaign 的选择，而不是"脚本直接算出答案"。
2. **评测材料在可变范围之外**：样本、参照 tokenizer、MAPE 公式全在 `bench/`，候选只能通过它实现的计数器影响分数，无法移动靶子。
3. **cwd 主仓库 + `$WEAVE_WORKSPACE` 读候选**：解决 worktree 没有 `node_modules`、无法解析 `tsx` 的问题。

**实测结果**：

```
npm run bench:rsi:self
  baseline MAPE 48.81%
  ... 17 处"接受" (修复前统计，含被覆盖的) ...
  best     MAPE 35.53%   (stop=max_cycles, evaluations=74)
  champion branch: rsi/ec51accb
```

被改动的正是那张手写的比值表：`system 3.5→3.73`、`assistant_thinking 3.0→3.8`、`assistant 3.5→3.58`、`assistant_progress 3.5→4`、`assistant_tool_call 2.5→2.73`、`tool_result 2.0→2.61`。

**验证**：`tsc` / `eslint` 干净，`npm test` **325 pass / 0 fail**（新增 cwd 与失败处理两组测试）。

### 傍晩续：模型驱动（模型真的改了自己的 harness）

**目标**：把脚本 mutator 换成真实模型，让候选由模型自己提出。

**新增 / 改动**：
- `bench/rsi-model.ts` + `npm run bench:rsi:model`：复用同一 target 与 scorer，mutator 换成 `ModelMutator`。
- `RsiCampaign` 新增 `seedFiles`：模型第 1 轮必须看到基线源码，否则无从下手；accepted 后 `best.files` 改为 merge 而非覆盖。
- champion 分支懒创建：没有接受任何改动就不留空分支。
- `ModelMutator` 容错：解析失败返回空提案 + `onParseError`，不中止 campaign；prompt 明确要求 raw JSON 并转义。

**实测（deepseek-flash）**：

```
npm run bench:rsi:model
  baseline MAPE 48.81%
  cycle 1  ACCEPT  Add CJK-aware token counting            -> 47.49%
  cycle 3  ACCEPT  expand CJK ranges, weight 1.5 -> 1.25    -> 43.42%
  cycle 4  ACCEPT  weight 1.25 -> 1.0                       -> 37.98%
  accepted=3 evaluations=10 cycles=4 stop=max_cycles
  champion branch: rsi/81884186
```

模型产出的不是调常量，而是一段完整的 CJK 感知计数实现（遍历码点，给 Hiragana/Katakana/Hangul/Unified Ideographs 扩展 A–I 等显式加权），正好对应原代码注释里写的 "it underestimates CJK text badly"。它就是**这段 harness 代码的作者**。

**验证**：主分支 `tsc` / `eslint` 干净，`npm test` **331 pass / 0 fail**（新增 model-mutator 与 seed 两组测试）。

### 修复：轮内覆盖 bug（重要）

用户跑 `bench:rsi:self` 时从日志里发现：cycle 1 明明把 `system 3.5 -> 4` 接受了，cycle 4 却仍从 `3.5` 提候选。

**根因**：mutator 在每轮开头基于**轮开始状态**一次性生成全部候选，而每个候选都是**整文件内容**（不是增量）。当同一轮里 ≥2 个候选被接受、且改的是同一个文件时，后一个的整文件内容会**覆盖**前一个的改动。后果：`acceptedCount` 虚高、`propose` 的 `A -> B` 有时是过期值、轮内没有复利。

⚠️ 最终分数并未造假：每轮最后一个被接受的候选正是被真实评测、且真正写进分支的那份内容。

**修复**（`src/rsi/campaign.ts`）：改为 **每轮只晋升一个最优候选**（Darwin-Gödel / Dream-RSI 的做法）。所有候选都对同一个 cycle-start champion 评分，只保留分数最高且超过 `minimumGain` 的那个。这样 mutator 下一轮看到的 `best.files` 就是真正的冠军，复利正确。

- 新增回归测试：一轮内两个都优于 baseline 的候选，只有分高者被晋升，且下一轮看到的基座是晋升者而非最后评测的落选者。
- 重跑 `bench:rsi:self`：`accepted` 从 17 降到 **12**（每轮至多 1 个），最终 MAPE 仍是 **35.53%**，比值表与修复前完全一致（说明坐标下降收敛到同一最优点，但以前统计不正确）。新分支 `rsi/8a10e615`。

> 说明：`rsi/ec51accb`、`rsi/e209ece6`（脚本）与 `rsi/81884186`（模型）都是修复前跑的，它们的 `acceptedCount` 偏大；最终指标仍有效。模型版需要用修好的引擎重跑一次（会产生新分支，需 API 调用）。

### 修复：TUI 文字选择坐标错位

用户反馈：用鼠标选中某行文字时，高亮出现在**上方两行**。定位到 `src/tty-app.ts`：

- `transcriptBodyStartY` 写死为 `headerPanel 行数 + 4`，但 session-feed 面板是 `frame: false`（无边框），实际正文从 `headerPanel 行数 + 1`（0-based）开始。又因为鼠标 `screenY` 是 1-based，正确值应为 `+2`，写死 `+4` 正好多 2 行。
- 水平也连带修了：`col = screenX - 3`（注释说"边框 2 + 左边留白 1"）同样依赖已不存在的边框，改为 `screenX - 1`。

修复后从实际 frame 推导行号（不再写死）：新增 `resolveTranscriptBodyStartY(linesAbove)`，`screenToAbsoluteLineIndex` 改为可测试的导出函数。新增回归测试 `test/transcript-selection-offset.test.ts`，并断言旧偏移下点击首行会被丢弃、点击第二行会错选首行。

### 修复：中文输入法（IME）预编辑不在输入框内

用户反馈：打字时文字不渲染在输入框内，而是显示在别处；按下输入法空格提交后才正常。

**根因**：TUI 用 `hideCursor()` 隐藏真实光标，输入框里的"光标"只是一个 reverse-video 字符块。终端在 IME 组合（preedit）时会**在真实光标位置**绘制候选文字，而 `renderTerminalFrame` 写完后并未把真实光标停到输入框，于是预编辑文字停在上一帧写入结束的位置（通常是最底部）。空格提交后，字符进入 `state.input`，由应用自己渲染到输入框，所以看起来"正常了"。

**修复**：新增 `inputPromptCaretWidth(input, cursorOffset)`（`tui/input.ts`，按显示宽度计算光标在输入文本内的列偏移），以及 `placeInputCursor(state, inputRow)`（`tty-app.ts`）。每帧渲染后用 `\u001b[row;colH` 把真实光标移到输入框内并 `showCursor()`；行号从 frame 推导，并支持输入折行。

遗留：审批面板的 feedback 输入用的是另一种布局（`Control: ...`），未定位光标，属同类问题，暂未处理。

**补充修复（第二次）**：上面只定位了光标，但用户反馈打字时预编辑仍会在"别处闪烁"。根因是每帧有**两次写入**：`renderTerminalFrame` 先把整帧写完，光标停在最后一行的末尾，之后才单独写光标移动。状态动画每 1s 触发一次渲染，IME 就会有一瞬间锚在底部。

修复：给 `renderTerminalFrame(frame, cursor?)` 增加可选光标参数，把光标移动与 `?25h` **拼进同一次 `write`**（全量渲染和 diff 渲染两条路径都处理；diff 路径即使无行变化也会写光标后缀）。`placeInputCursor` 改写为纯函数 `computeInputCursor`，不再自己写 stdout。新增回归测试 `test/render-terminal-cursor.test.ts` 断言"一帧一次写入且以光标序列结尾"。

### 新增：全局命令 `weave`（任意目录可用）

用户反馈：想像 `pi` 一样在任意目录直接输入 `weave`。

**问题**：`bin/weave` 是 bash 脚本，Windows 上 npm 生成的 shim 不可靠；`src/install.ts` 的 `hasPathEntry` 用 `':'` 分隔 PATH（Windows 应为 `';'`），且只写 bash 启动器；`~/.local/bin` 也不在 PATH 上。

**修复**：
- 新增 `bin/weave.mjs`：跨平台 Node 启动器，从项目 `node_modules` 解析 `tsx`，以**调用者当前目录**为 cwd 启动 CLI。
- `package.json` 的 `bin` 指向 `./bin/weave.mjs`；`bin/weave` 保留为 git-bash 薄封装（`exec node weave.mjs`）。
- `src/install.ts`：`hasPathEntry` 改用 `path.delimiter`；Windows 写 `weave.cmd`，Unix 写 bash 启动器；提示改为 `weave`。

**使用**：
```bash
npm link      # 注册到 npm 全局 bin（已在 PATH 上）
weave         # 任意目录直接启动，以当前目录为工作区
```

**验证**：`weave --help` 在 bash / cmd / PowerShell 均能解析；在临时目录启动确认使用该目录（需用 `MINI_CODE_HOME` 避免污染真实配置）。

### 品牌统一：`minicode` → `weave` / `MiniWeave`

**用户可见文案**（全部改为 weave / MiniWeave）：
- CLI usage（`weave management commands`、`weave mcp/skills ...`）
- 顶部 banner 标题、输入框提示符（`mini-code prompt>` → `weave> `）
- 审批/权限提示、会话保存的 resume 提示、`/status` 输出、`/init` 生成的 MINI.md 与 .gitignore 注释、skills/MCP 提示、web 抓取的 User-Agent

**模型提示词**：`src/prompt.ts` 首行改为 `You are MiniWeave (the terminal command is \`weave\`), a plugin-based terminal coding agent.`

**内部命名**：`MiniCodeSettings` → `MiniWeaveSettings`，`saveMiniCodeSettings` → `saveMiniWeaveSettings`（同步 `cli-commands.ts` / `install.ts`）。

**目录与环境变量**（向后兼容）：
- 数据目录默认 `~/.weave`；若 `~/.mini-code/` 已存在且 `~/.weave/` 不存在，则继续沿用旧目录，**不丢失配置与会话**；支持 `MINIWEAVE_HOME`（优先于 `MINI_CODE_HOME`）。
- 项目配置目录默认 `.weave/`，回退到已存在的 `.mini-code/`；memory/skills 扫描同时兼容两者。
- 环境变量：`MINIWEAVE_*` 优先，`MINI_CODE_*` 作为上游遗留别名继续可用。

**验证**：`weave --help` 输出 `weave management commands`；系统提示词首行为 MiniWeave；`tsc`/`eslint` 干净，`npm test` **340 pass / 0 fail**。

### 遗留问题 / 下一步

- **scorer 需要复合目标**：现在只测 token MAPE，候选可能破坏其他行为；应把 `npm test` 纳入评测。
- **合并前校验**：接受项应在分支上跑一遍完整 `npm test`（worktree 无 `node_modules`，需要 junction/符号链接）。
- 还差**通用 MiniWeave-Bench**（多类型任务集）作为除 token MAPE 之外的适应度来源。
- RSI 还没接进 `SessionRuntime`（`mode: 'rsi'` / `/rsi`）与 TUI；`src/plugin/` 仍未接线。
- GUI 尚未开始；计划先抽 `AgentEvent` 协议，让 TUI 与 GUI 共用（同时可喂给 RSI 的 trace）。
- 未做 replay 进化探索策略（Dream-RSI 的差异化点），暂列为 P1。
