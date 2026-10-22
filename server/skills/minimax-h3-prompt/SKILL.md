---
name: minimax-h3-prompt
description: MiniMax H3 官方视频提示词规范（T2VA/I2VA/FL2VA/L2VA/Ref2VA）：三字段 integrated_multimodal_description / overall_soundscape / non_diegetic_music、首尾帧对齐、镜头时间码、运镜、说话人 (S1)、<d> 台词、参考标签。已按官方 h3-prompt-writing v1.0.1 校正，并补充 H3 i2v/r2v 互斥、H3-Max 限制和 onekey 用法。
version: 1.2.0
author: MiniMax（本地整理，同步官方 h3-prompt-writing）
category: video
tools: [generate_video, onekey_shot_video]
---

# MiniMax H3 视频提示词写作（官方结构）

> 官方源：`MiniMax-AI/MiniMax-H3` 的 `skills/h3-prompt-writing`，最新提交 `a107547f`（2026-08-11，v1.0.1）。
> 本技能目录下的 `references/base-en.txt`、`references/ref-en.txt` 内容与官方原文一致（仅换行符不同），需要完整案例时用 `fs_read` 精读。
> API 文档：https://platform.minimax.io/docs/guides/video-generation

## 0. 先选模式，并先排除无效组合

| 模式 | 输入 | 第一行 | 正文结构 |
|---|---|---|---|
| T2VA | 无图、无参考 | 无 | 三字段 |
| I2VA | 仅首帧 | I2VA 首帧对齐行 | 三字段 |
| FL2VA | 首帧 + 尾帧 | FL2VA 首尾对齐行 | 三字段 |
| L2VA | 仅尾帧 | L2VA 尾帧对齐行 | 三字段 |
| Ref2VA | 参考图/视频/音频，无关键帧 | 无 | 六段式 |

**H3 API 硬规则（写提示词和调用工具前都要检查）：**

- `first_frame` / `last_frame` 与 `reference_image` / `reference_video` / `reference_audio` **互斥**，同一请求不能混用。走 i2v 时只保留首帧/尾帧自身的 `<Picture N>`，不要再传参考素材或写额外的 `<Subject N>` 引用；走 r2v 时不要再传首尾帧。
- 参考音频不能单独使用，必须至少配一张参考图或一段参考视频。
- H3 参考素材上限：图 9 张、视频 3 段、音频 3 段；参考音频每段 2–15 秒。
- `MiniMax-H3`：768P/2K，4–15 秒，支持 t2v/i2v/r2v。
- `MiniMax-H3-Max`：480P/768P，5–15 秒，只支持 t2v/i2v，**不支持参考素材和 2K**；给 H3-Max 写提示词时禁用 Ref2VA。
- 文生视频必须给具体 `ratio`；图生视频固定 `adaptive`；参考生视频默认 `adaptive`，也可用具体比例。

**本工作室 onekey 路由：**

- 该镜已有 `image_url` → i2v，首帧即 `<Picture 1>`，走 I2VA；不要再把角色/场景参考图塞进同一次 H3 请求。
- 该镜没有画面、但有角色/场景资产 → r2v，走 Ref2VA；参考图按工具实际装配顺序对应，不得虚构不存在的编号。
- 两者都没有 → 先补角色/场景资产或关键帧，不要用空提示词硬生成。
- H3 的 I2VA 与通用 `prompt-basics` 的“i2v 只写动作和运镜”不同：**必须锚定首帧里的身份、服装、构图、空间关系**，再写后续动作；否则会漂移。

## 1. Base 模式：对齐行 + 三字段

### 1.1 对齐行（仅 I2VA / FL2VA / L2VA）

```text
I2VA: For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

FL2VA: How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.

L2VA: How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.
```

- `N` 是实际最后一个镜头号；`S.SS` 是视频总时长，必须两位小数（8 秒 → `8.00`）。
- 对齐行是最终提示词第一行，后面空一行再写三字段。
- T2VA 不写对齐行，直接从 `integrated_multimodal_description:` 开始。

### 1.2 三字段（顺序和字段名固定）

```text
integrated_multimodal_description: [Shot 1] [风格与初始构图]。[主体身份/位置/动作/运镜]。[说话人 (S1) + <d>[语言] 原台词</d>]。 [Shot 2] At 00:03.500, ...

overall_soundscape: [全片环境声、动作声、非语言人声，1-4 句一段]

non_diegetic_music: [观众能听到、角色听不到的配乐：乐器/速度/节奏/强弱变化；没有就写 N/A]
```

- 台词、唱歌、角色能听到的音乐（收音机/电视/手机/现场乐器）写在描述里。
- 持续环境声、动作声、呼吸/笑声等非语言人声写 `overall_soundscape`，不要重复台词。
- 只有观众能听到的配乐写 `non_diegetic_music`；没有就 `N/A`；只有用户明确要求全片静音时 `overall_soundscape` 才写 `N/A`。
- 同一个声音不要跨字段重复。

### 1.3 关键帧写法

- **I2VA**：`<Picture 1>` 是 0.00 秒真实首帧，属于 `[Shot 1]`。先写风格、主体、构图、场景锚点，再写动作起点、连续发展、结果/反应；身份、服装、颜色、关键道具、空间关系保持不变。
- **FL2VA**：Picture 1 是开场，Picture 2 是结尾。写主体移动、姿态变化、道具操作、构图演变、光线过渡；一般单镜，最后一镜结束时必须落到尾帧。
- **L2VA**：`<Picture 1>` 是最后一镜的尾帧，不属于 Shot 1。先推一个可信的前置状态，再写动作/转场路径，最后收敛到尾帧。
- 关键帧模式不要重复两张静态图的描述；要写“从首帧到尾帧之间发生了什么”。

## 2. 镜头、时间码、运镜

- `[Shot 1]` **不加时间码**；后续镜头用 `[Shot 2] At 00:03.500, ...`，时间严格递增且在片长内。
- 普通切镜用 `the camera cuts to` / `the shot cuts to` / `the shot transitions to` / `the shot changes to` / `the shot switches to`。只有用户明确要求时才用叠化、淡入淡出、划像。
- 切镜必须带来新信息（主体/空间/状态/视角/时间）；只想改变景别或轻微角度时优先用运镜。
- **本项目逐镜生成**：每镜一个独立 3–10 秒视频时，只写一个 `[Shot 1]`，不写任何时间码，也不写“第 1 秒/第 2 秒”。
- 只有把同一场景多个节拍合并成一条 ≤15 秒视频时，才从 `[Shot 2]` 起写递增切镜时间，并复用同一场景/光线/角色描述。
- 运镜写成自然句子，包含类型 + 幅度 + 速度；中等幅度/正常速度可省略：
  - 类型：`Zoom In/Out`、`Push In/Pull Out`、`Pan Left/Right`、`Truck Left/Right`、`Tilt Up/Down`、`Pedestal Up/Down`、`Arc Shot`、`Tracking Shot`、`Static Shot`、`Shake Slightly/Strongly`、`POV`、`Roll Clockwise/Counterclockwise`
  - 幅度：`with small amplitude` / `with large amplitude`
  - 速度：`at slow speed` / `at fast speed`

```text
[Shot 1] ... The camera pushes in with small amplitude at slow speed toward the folded letter in her hands.
[Shot 2] At 00:05.000, the camera pans right with large amplitude at fast speed, revealing the open doorway.
```

## 3. 说话人、台词、屏上文字

- 说话/唱歌/画外人声用稳定 ID：`(S1)`、`(S2)`；多人齐声 `(S1,S2)`；同一角色跨镜保持同 ID；从不发声的角色不编号。
- 首次出现时给身份线索：角色类型/年龄/性别/是否在画面内/音色/语速/口音。身份、动作、语气写在 `<d>` 外。
- `<d>` 内只放语言标签 + 用户原文逐字；不翻译、不改写、不增删标点：

```text
The young woman with a quiet, breathy voice (S1) says: <d>[English] I get off at the next station.</d>
The young man (S1) says in an off-screen voiceover: <d>[Chinese] 我还记得那条路。</d> while his lips remain completely closed.
```

- 画外音必须用精确短语 `says in an off-screen voiceover`，并在 `<d>` 后说明对应在画人物的嘴唇保持闭合。
- 台词/歌词跨切镜：两侧接口用 `<scenetrans>`，并说明声音连续（`continues seamlessly across the cut`）；被片尾截断用 `<cutoff>`。
- 画面内可见文字（招牌/横幅/字幕）用英文双引号保留原文：`A red neon sign reading "营业中" glows above the doorway.`

## 4. Ref2VA：多参考六段式

顺序固定，不可调换：

1. `subject_definitions`
2. `summary`
3. `retention_analysis`
4. `detailed_description`
5. `overall_soundscape`
6. `non_diegetic_music`

### 4.1 参考标签

| 标签 | 含义 |
|---|---|
| `<Subject N>` | 可复用/可修改的可见内容（人物/场景/服装/道具/风格/动作/表情/姿态） |
| `<Picture N>` | 作为首帧、关键帧、尾帧或构图锚点的参考图 |
| `<Video N>` | 提供剪辑来源、续接起点或整片时间结构的参考视频 |
| `<Audio N>` | 被复制或引用的音频（音色/对白/节拍/氛围） |

- 只用来定义人物/场景/风格、不单独作为帧的图片，不单列 `<Picture N>`，写进对应 `<Subject N>` 的定义。
- 同一内容可以来自多个资产；一个资产也可以提供多个 Subject。
- `<Video N>` 和 `<Audio N>` 各自独立编号；同一参考视频可能是 `<Video 1>` + `<Audio 2>`，不要强行配对。
- 标签一旦赋值，全文含义一致；不得出现未定义或悬空标签。

### 4.2 `subject_definitions` 与 `summary`

- 每个需要后续追踪的内容单独一行，说明标签、参考角色、要保留的主要特征；必要时写来源资产。
- `summary` 用一段英文，以方括号任务类型开头，例如 `[reference generation + audio reference]`。
- 任务类型按实际作用选：`keyframe completion`、`reference generation`、`video editing`、`video continuation`、`audio reuse`、`audio reference`；多种关系用 ` + ` 连接，不重复。
- 只是借鉴参考视频的运镜/剪辑/节奏，通常算 `reference generation`，不要误写成 `video editing` 或 `video continuation`。
- 摘要里只能使用已定义的标签，不要引入新标签。

### 4.3 `retention_analysis`

- 每个参考标签一行，沿用 `subject_definitions` 里的含义。
- 可见内容固定标记：`fully_preserved`、`partially_preserved`、`attribute_transfer`、`weak_reference`。
- 音频固定标记：`fully_copy`、`partially_copy`、`reference`、`weak_reference`。
- **这里不要写 `(Sx)` 说话人 ID**；说话人只在 `detailed_description` 的实际发声处出现。

### 4.4 `detailed_description`

- 正文用英文；台词/歌词/屏上文字保留原语言原文。
- 先用 1–2 句建立整体风格，再写 `[Shot 1]`；后续镜头 `[Shot N] At MM:SS.mmm, ...`。
- 生成任务通常 350–500 英文词；对白密集时优先保证完整台词时间轴，不要机械凑字数。
- 每个镜头写清：构图、主体外观与位置、环境与光线、动作与状态变化、运镜、当前声音、参考内容真正生效的位置。
- 不要退化成剧情摘要或参考关系清单。
- 直接复用参考音频里的台词/旁白/歌词，或用户要求重演时，原文放 `<d>`；听不清写 `[unclear]`，不要猜。
- 只参考音色/节奏/情绪/表演时，不要把参考音频里的原台词搬进目标视频。
- 说话人按目标视频实际发声顺序编 `(S1)`、`(S2)`；`<Audio N>` 绑定到某个说话人时复用同一 ID，不单独重新编号。

### 4.5 两个声音段

- `overall_soundscape`：全片环境声、物理动作声；对白、唱歌、与具体镜头同步的声音留在 `detailed_description`。
- `non_diegetic_music`：只有观众能听到的配乐，写乐器、速度、节奏、动态变化；不要写抽象情绪词。
- 参考音频用于环境/音效时，在 `overall_soundscape` 说明复制/参考关系；用于观众专属配乐时，在 `non_diegetic_music` 说明。

## 5. 在本工作室怎么用

- 写/改视频提示词前：`read_skill("minimax-h3-prompt")`；需要逐字案例时再 `fs_read` 本目录下的 references。
- 成稿通过 `onekey_shot_video(..., prompt_override="...")` 注入；`prompt_override` 原样作为基础提示词。
- 成稿已含 `integrated_multimodal_description` 等 H3 字段时，不要再追加风格后缀；已含 `camera` 或 `[Camera:` 时，不要再追加运镜后缀，避免破坏结构。
- onekey 的参考图装配顺序是：先该镜出场角色参考（每人最多 3 张），最后场景参考。写标签前确认实际传入的张数；无法确认时用角色名/自然语言描述，**不要编造 `<Picture 3>` 之类不存在的引用**。
- i2v 场景：只写 I2VA 对齐行 + 三字段，不要再写 `<Subject>` 参考标签，也不要把参考图塞进请求。
- r2v 场景：用 Ref2VA 六段式；主体身份用 `<Subject N>`，具体帧锚点才用 `<Picture N>`。

### r2v 单镜示例（无关键帧，5 秒）

```text
subject_definitions:
<Subject 1> is the young woman in <Picture 1>, preserving her face, long dark hair, blue cardigan, and thin silver necklace.
<Subject 2> is the empty classroom environment in <Picture 2>, with worn wooden desks, chalk handwriting on the blackboard, and warm afternoon light.

summary:
[reference generation] The target video shows <Subject 1> standing by the classroom window in <Subject 2> as she turns toward the sunlight.

retention_analysis:
<Subject 1> ([Shot 1]): fully_preserved - her face, hairstyle, blue cardigan, and necklace are retained.
<Subject 2> ([Shot 1]): fully_preserved - the desks, blackboard, and warm window light are retained.

detailed_description:
The target video uses a 2D-animated, cinematic style with soft afternoon light and visible chalk dust.
[Shot 1] A medium shot frames <Subject 1> beside the window in <Subject 2>. She keeps the appearance, clothing, and position defined by <Picture 1>, then turns her head toward the sunlight as the camera pushes in with small amplitude at slow speed. Chalk dust drifts through the beam and settles on the desks.

overall_soundscape:
Quiet classroom room tone, faint wind against the window frame, and a soft cloth rustle as she turns.

non_diegetic_music:
A solitary piano line at a slow tempo with a soft, steady decay.
```

### i2v 单镜示例（首帧，5 秒）

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] 2D-animated, cinematic, the young woman in <Picture 1> remains beside the classroom window, preserving her face, blue cardigan, and the room layout. The camera pushes in with small amplitude at slow speed as she lifts her gaze toward the sunlight, chalk dust drifting through the beam.

overall_soundscape: Quiet classroom room tone, faint wind against the window frame, and a soft cloth rustle as she moves.

non_diegetic_music: A solitary piano line at a slow tempo with a soft, steady decay.
```

## 6. 输出前自查

1. 模式选对：有首帧走 I2VA/FL2VA，有尾帧无首帧走 L2VA，有参考无关键帧走 Ref2VA，无素材走 T2VA。
2. H3 请求没有同时出现首/尾帧和参考素材；H3-Max 没有参考素材和 2K。
3. 对齐行是首行、时长为两位小数、`[Shot 1]` 无时间码、切镜时间递增。
4. 三字段名称和顺序正确；Ref2VA 六段顺序正确。
5. 参考标签有定义、全文一致、没有悬空引用。
6. 台词/歌词/屏上文字保留原语言原标点；其余描述为英文。
7. 运镜写成“类型 + 幅度 + 速度”的自然句；少用 `cinematic/beautiful` 等空词。
8. 描述中的动作和时长匹配实际请求（H3 4–15s，H3-Max 5–15s）。
