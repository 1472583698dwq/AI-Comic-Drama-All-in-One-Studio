---
name: minimax-h3-prompt
description: MiniMax H3 官方视频提示词规范（T2VA/I2VA/FL2VA/L2VA/Ref2VA）：三字段结构 integrated_multimodal_description / overall_soundscape / non_diegetic_music、首尾帧对齐行、镜头时间码、运镜三维度、说话人 (S1) 与 <d> 台词、参考标签 <Subject/Picture/Video/Audio N>。写/改视频提示词（含 onekey_shot_video 的 prompt_override）前先读本技能。
version: 1.1.0
author: MiniMax（本地整理：对齐官方 h3-prompt-writing skill）
category: video
tools: [generate_video, onekey_shot_video]
---

# MiniMax H3 视频提示词写作（官方结构）

> 来源：MiniMax 官方 H3 仓库 `skills/h3-prompt-writing`（2026-08 发布）+ 社区指南的字段细则。
> 完整英文参考（本技能目录下，可 `fs_read` 精读）：
> - `references/base-en.txt`（T2VA / I2VA / FL2VA / L2VA 全文与案例）
> - `references/ref-en.txt`（Ref2VA 六段式与参考标签细则）

## 0. 先选模式（由"你手里有什么素材"决定，不是感觉）

| 模式 | 素材 | 说明 |
|---|---|---|
| T2VA | 无图 | 纯文本构建完整音画时间轴 |
| I2VA | 首帧图 | T2VA 主体 + 首帧对齐行 + 从首帧向前发展 |
| FL2VA | 首帧+尾帧 | T2VA 主体 + 首尾对齐行 + 首→尾连续路径（一般单镜） |
| L2VA | 尾帧图 | T2VA 主体 + 尾帧对齐行 + 收敛到尾帧 |
| Ref2VA | 多参考（图/视频/音频） | 六段式改写，参考标签贯穿全文 |

本工作室的 onekey 逐镜生成里：**没有关键帧 → r2v 参考生视频**（用参考图当 `<Subject>`/`<Picture>` 描述）；
**有关键帧 → i2v**（首帧 = `<Picture 1>`，走 I2VA 对齐行）。

## 1. 最终提示词结构（Base 模式）

### 1.1 第一行是"对齐指令"（仅 I2VA/FL2VA/L2VA 需要；T2VA 直接从字段开始）

```text
I2VA: For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

FL2VA: How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.

L2VA: How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.
```

- `N` = 实际最后一个镜头号；`S.SS` = 视频总时长，**两位小数**（8 秒 → `8.00`）。
- 对齐行后空一行，再写三字段。

### 1.2 三字段（顺序固定，字段名原样保留）

```text
integrated_multimodal_description: [Shot 1] [风格与初始构图]。[主体身份/位置/动作/运镜]。[说话人 (S1) + <d>[语言] 原台词</d>]。 [Shot 2] At 00:03.500, ...

overall_soundscape: [全片环境声、动作声、非语言人声，1-4 句一段]

non_diegetic_music: [观众能听到、角色听不到的配乐：乐器/速度/节奏/强弱变化；没有就写 N/A]
```

- **字段职责不混用**：台词/唱歌/画面里的音乐（角色能听到）→ 写在描述里；持续环境声 → `overall_soundscape`；观众专属配乐 → `non_diegetic_music`。同一个声音不要跨字段重复。
- `overall_soundscape` 不重复台词；仅当用户明确要求全片静音才写 `N/A`。

## 2. 镜头与时间码

- **`[Shot 1]` 不加时间码**（加了是官方指南明确的错误）；后续镜头 `[Shot 2] At 00:03.500, the camera cuts to ...`。
- **本项目逐镜生成**（每镜一个独立 3-10 秒视频）：单镜提示词只有一个 `[Shot 1]`，**不写任何时间码**（也不要写"第1秒/第2秒"这类描述）。
- **可选策略·场景内多拍合并**：把同一场景的多个节拍合并成一条视频（单条 ≤ 15 秒，视频源支持时）——此时才用切镜时间，从 `[Shot 2]` 起写递增 `At 00:0X.XXX`，且同一条视频内必须复用同一场景/光线/角色描述保持连贯。
- 场景一致性（本项目按场景组织）：同一场景的所有镜头/多拍共用 同一场景参考图、同一光线（time_of_day 决定）、同一氛围与道具、同一风格；只改动作与运镜。
- 切镜时间严格递增且在片长内；普通切镜用 `the camera cuts to / the shot cuts to / transitions to / changes to / switches to`。
- 仅需改变景别或轻微角度时，优先用运镜而不是切镜。
- 切镜必须带来新信息（主体/空间/状态/视角/时间）。

## 3. 运镜：动作类型 + 幅度 + 速度（写成句子，不要标签堆砌）

- 类型：`Zoom In/Out`、`Push In/Pull Out`、`Pan Left/Right`、`Truck Left/Right`、`Tilt Up/Down`、`Pedestal Up/Down`、`Arc Shot`、`Tracking Shot`、`Static Shot`、`Shake Slightly/Strongly`、`POV`、`Roll Clockwise/Counterclockwise`。
- 幅度：`with small amplitude` / `with large amplitude`（中等可省略）。
- 速度：`at slow speed` / `at fast speed`（正常可省略）。

```text
[Shot 1] ... The camera pushes in with small amplitude at slow speed toward the folded letter in her hands.
[Shot 2] At 00:05.000, the camera pans right with large amplitude at fast speed, revealing the open doorway.
```

## 4. 说话人、台词、屏上文字

- 说话/唱歌/画外人声用稳定 ID：`(S1)`、`(S2)`；多人齐声 `(S1,S2)`。同一角色跨镜保持同 ID；从不发声的角色不编号。
- 首次出现时给身份线索（角色类型/年龄/性别/在不在画面内/音色/语速/口音）。
- **`<d>` 内只放语言标签 + 用户原文逐字（不翻译、不改写）**；身份、动作、语气写在 `<d>` 外：

```text
The young woman with a quiet, breathy voice (S1) says: <d>[English] I get off at the next station.</d>
The young man (S1) says in an off-screen voiceover: <d>[Chinese] 我还记得那条路。</d> while his lips remain completely closed.
```

- 台词跨切镜：两侧接口用 `<scenetrans>`，并说明声音连续（`continues seamlessly across the cut`）；被片尾截断用 `<cutoff>`。
- 画面内可见文字（招牌/横幅/字幕）用英文双引号原样保留：`A red neon sign reading "营业中" glows above the doorway.`

## 5. Ref2VA（多参考）六段式

顺序固定：`subject_definitions` → `summary` → `retention_analysis` → `detailed_description` → `overall_soundscape` → `non_diegetic_music`。

参考标签（赋值后全文含义一致）：

| 标签 | 含义 |
|---|---|
| `<Subject N>` | 可复用/可修改的可见内容（人物/场景/服装/道具/风格/动作） |
| `<Picture N>` | 作为首帧、关键帧、尾帧或构图锚点的参考图 |
| `<Video N>` | 提供剪辑来源、续接起点或整片时间结构的参考视频 |
| `<Audio N>` | 被复制或引用的音频（音色/对白/节拍/氛围） |

- 只用来定义人物/场景/风格、不单独作为帧的图片 → 不单列 `<Picture N>`，写进对应 `<Subject N>` 的定义里。
- `retention_analysis` 逐项记录：在哪出现、完全/部分保留、迁移、还是复用。
- `detailed_description` 要"最详细"：每个镜头写清构图、主体外观与位置、环境与光线、动作与状态变化、运镜、当时声音，以及参考内容真正生效的位置——不要退化成剧情摘要。

## 6. 输出红线（写完自查）

1. 描述总时长与实际请求时长（4–15 秒）匹配；时间码格式 `00:03.500`、总时长两位小数。
2. `[Shot 1]` 不带时间码；切镜时间递增。
3. 参考标签全文一致、有定义、无悬空引用。
4. 具体名词优先，少用 `cinematic/beautiful` 等空词；运镜写"类型+幅度+速度"。
5. 台词/歌词/屏上文字保留原语言原文；其余描述用英文。
6. 不写剧情摘要，不写与目标时长不符的时间码。

## 7. 在本工作室怎么用

- Agent 写/改视频提示词前：`read_skill("minimax-h3-prompt")`（本技能），需要全文案例时 `fs_read` 上面的 references 文件。
- 用 `onekey_shot_video(draft_id, shot_index, prompt_override="...")` 注入成稿：
  - 工具默认自动装配 参考图（角色多视图+场景）/运镜/风格；**`prompt_override` 会原样作为基础提示词**（含 camera 等关键词时不再追加运镜后缀；含 `integrated_multimodal_description` 等 H3 字段时不再追加风格后缀，避免破坏三段结构）。
  - r2v 场景：把参考图当 `<Picture 1>`/`<Subject 1>` 描述一致性（例：`<Subject 1> is the young woman in <Picture 1>, ...`），让 H3 保人保景。
  - i2v 场景：首帧即 `<Picture 1>`，用 I2VA 对齐行开场，主体外观/服饰/机位与首帧保持一致。
- 示例（r2v 单镜 5 秒）：

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] 2D-animated, cinematic, <Subject 1> (the young woman in <Picture 1>, preserving her face, hairstyle and blue cardigan) stands by the classroom window in the empty room from <Picture 2>. The camera pushes in with small amplitude at slow speed as she turns her head toward the sunlight, chalk dust drifting in the beam.

overall_soundscape: Quiet classroom room tone, faint wind against the window frame, cloth rustle as she shifts.

non_diegetic_music: A solitary piano line at a slow tempo with a soft, steady decay.
```
