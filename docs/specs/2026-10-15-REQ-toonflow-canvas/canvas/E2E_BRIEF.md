# E2E 执行说明（3 个测试 agent 共用）

- 被测：worktree `~/project/ads/dwq147-src-canvas` 分支 `feature/toonflow-canvas`（HEAD 957929e）。
- 实例：前端 `http://127.0.0.1:5180`（Vite HMR）、后端 `http://127.0.0.1:8001`（用这个 worktree 的代码和 `storage/`）。**不要重启、不要停 8001/5180**（三个测试 agent 共用）；需要后端改动的，记录下来交给协调人。
- 浏览器：自己起 headless Chromium（playwright；若浏览器缺失，用 `~/Library/Caches/ms-playwright` 下已装的 chromium 通过 executablePath 启动），**不要用应用内浏览器面板**（会和别的 agent 抢）。
- LLM：测试实例已接用户自己的 OpenAI 兼容网关（模型 薄荷/qwen3.8-27b-262k），可正常调用。
- 生成：**只允许免费的本地生成**——图片用「ComfyUI (本地/云端)」生成源；视频用 comfyui_video（会走兜底：首帧循环成视频，只能证明链路）；音频没有可用的语音源（MiniMax 缺 key、CosyVoice/GPT-SoVITS 未启动）→ 生成类音频用例判「阻塞」并写明原因。**禁止**调用 AutoDL、MiniMax、Kling 等付费源。ComfyUI 是单队列，生成慢属正常（单张约 20–90s）。
- **只测试和诊断，不改代码，不改 `testing.md`**。用例本身有问题（与已定规则冲突、步骤不可执行等）就判「用例问题」并说明，不要自行改断言。
- 每条用例记录：结果（通过 / 失败 / 阻塞 / 用例问题）、操作步骤要点、实际现象、截图文件名；**失败的必须给出根因定位**（文件:行号 + 一句话原因 + 建议修法）。
- 截图存 `docs/specs/2026-10-15-REQ-toonflow-canvas/canvas/e2e/<你的编号>/`（JPEG，宽 ≤1400）。
- 结果写 `docs/specs/2026-10-15-REQ-toonflow-canvas/canvas/progress/<你的编号>.md`：顶部汇总表（用例 / 结果 / 一句话），下面逐条细节。
- 只在分配给你的项目里操作；需要的节点自己在画布上建。测完把你新建的测试画布、上传的素材、生成的文件清理掉（分配项目里原有数据不许改坏；迁移类用例本来就会改写画布结构，属预期）。后端重启时会清扫缺原文件的素材记录：如发现 `storage/assets/*/meta.json` 被删，用 `git checkout -- storage/assets` 恢复（不提交 storage）。
- 视觉判断以 Toonflow 为准（参考 `~/project/drama/01-toonflow`，也可打开 `https://01.apeiria.cc.cd` 的 Toonflow 演示画布对照）：标题在卡片外上方、卡片 12px 圆角无阴影、端口悬停才显示、浮动工具栏/提示词面板、贝塞尔连线等；颜色跟 MiniMax 主题（深/浅色）。
