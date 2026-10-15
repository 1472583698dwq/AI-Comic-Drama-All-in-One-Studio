# REQ-toonflow-canvas · 验收结果（2026-10-15）

分支 `feature/toonflow-canvas`（worktree `~/project/ads/dwq147-src-canvas`），基于 `f76838b`，9 个提交，277 个文件 +49508/−6815。

## 端到端用例（testing.md，38 条）

| 结果 | 用例 |
|---|---|
| 通过（首轮） | A1–A9、B2–B7、B9、B11、B12、C1、C2、C4、C6–C8、D1–D3、D6、E1–E3 |
| 首轮失败 → 已修复并复测通过 | B1（文本流式写入）、B8（视频多参考 mode 丢失）、C5（代码节点被「提示词为空」拦截）、D4（分镜「在画布中运行」不回写）、D5（Agent 执行结果不写回画布；为原有 bug，复测用直接调用 `canvas_execute` 验证，网关不稳未走 Agent 对话） |
| 部分阻塞（环境原因，非本需求） | B10 音频生成：无可用语音源（MiniMax 缺 key、CosyVoice/GPT-SoVITS 未启动）；连线上限与面板通过。C3 时间线：MP4 合成通过；剪映草稿缺 `pyJianYingDraft`、`pymediainfo`（不在 requirements.txt，线上实例同样缺） |

用例修订：B8 一处（实施前，按已定规则更正，见 testing.md 末尾）。

## 测试套件

- 前端：`tsc -b` 0 错；vitest 645/645（基线 90）。
- 后端：735 通过、4 跳过、1 失败（`test_skill_engine::test_default_scan_stays_inside_project`，改动前即失败，与本需求无关）。

## 顺带修复的原有 bug

- MCP 画布工具未传画布 id 时覆盖 `default` 画布（数据丢失）
- 后端执行器从不向视频源传尾帧 / 参考视频 / 机位
- `canvas_execute` 结果不写回画布；指定 `target_ids` 时连带重跑兄弟生成节点（付费源会白花钱）
- 插件代码节点拿不到输入（inputs/params 未拆分）；DAG 上游新值没落到插件声明端口
- 文本节点后端技能分支对字符串调 `.get()` 必失败
- 素材上传把 webm/m4a/mov 等存成 `.png`
- 3D 舞台在画布缩放下关节拾取偏移；录制尾帧丢失
- 内置 ComfyUI 负向提示缺 NSFW 安全词（中文提示词送二次元 SDXL 曾出不相干的露骨图）

## 待决定 / 已知限制

- 智能规划开启时，未保存的默认参数不随请求下发（让 Agent 自己定比例/时长）；如需也下发，改一处即可。
- 测试实例 LLM 接的是用户 GPROXY 网关（仅写在 worktree 被 git 忽略的 `storage/config_store.json`）；网关首 token 偶尔 70s+，智能规划超时已改为可配（默认 90s，`CANVAS_AGENT_PLAN_TIMEOUT_S`）。
- 后端每次启动会清扫「原文件缺失」的素材记录（原有行为）；在 worktree 里跑会删掉 7 条被 git 跟踪的 meta.json，需 `git checkout -- storage/assets` 恢复。
- 尚未合并进主工作副本 / 未推送。
