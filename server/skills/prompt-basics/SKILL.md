---
name: prompt-basics
description: 基础提示词规范（跨模型通用兜底）：六要素骨架 Subject/Action/Setting/Camera/Lighting/Style、运镜语法、光线与氛围、i2v 只写运动与运镜、多镜分块、常见错误对照。任何图片/视频提示词（生图、i2v、r2v、t2v）都先按本技能组装；MiniMax H3 专用结构另见 minimax-h3-prompt 技能。
version: 1.0.0
author: 本地整理（综合 Veo/Kling/Sora/Hailuo/Seedance 官方指南）
category: prompt
tools: [generate_image, generate_video, onekey_shot_image, onekey_shot_video, onekey_role_image, onekey_scene_image]
---

# 基础提示词规范（所有生成模型的通用底稿）

> 结论先行：**弱提示词不是短，是缺要素**——缺的要素模型会每轮到每个随机答案去补（Kling 官方公式 / Veo 指南 / Sora 指南 / Hailuo 骨架一致结论）。
> 任何"只给台本一句话就去生成"的做法都会得到不可复现的平庸结果。写任何生成提示词前，先按下面的骨架过一遍。

## 1. 六要素骨架（一条镜头 = 六个回答）

```text
[Camera] Subject + Action, in Setting, Lighting clause, Style clause.
```

| # | 要素 | 回答的问题 | 写法要点 | 示例 |
|---|---|---|---|---|
| 1 | Subject 主体 | 谁/是什么 | 3-5 个可识别细节（年龄/发型/服饰/材质），与参考图一致的角色直接用名字+“同一角色” | 扎低马尾的年轻女教师，藏蓝外套 |
| 2 | Action 动作 | 主体做什么 | 一个主运动 + 最多一个环境次级运动；用副词 slowly/gently/hesitantly | 缓缓推开木门，衣角被穿堂风吹动 |
| 3 | Setting 环境 | 在哪、周围有什么 | 地点+时间+2-3 个标志物（前景/中景/背景） | 山村教室，黄昏，斑驳黑板与斜射的窗光 |
| 4 | Camera 运镜 | 镜头怎么拍 | **类型+幅度+速度**；静止就显式写 Static；“标签堆”无效 | 中景，镜头缓慢推近（小幅度） |
| 5 | Lighting 光线 | 光从哪来、什么色调 | 光源+方向+色温；写明“光线保持不变”可锁一致性 | 暖金色夕照从左侧窗外斜射，光柱中有浮尘 |
| 6 | Style 风格 | 什么质感 | 一个风格锚点+一个质感词（别写"beautiful/cinematic"空词） | 动画赛璐璐质感，浅景深，胶片颗粒 |

**顺序不必死板，但六要素必须都出现（可极简，不可缺席）。**

## 2. 具体名词优先（弱 → 强 对照）

| 弱（空词） | 强（具体名词） |
|---|---|
| 一条漂亮的夜街 | 湿沥青、斑马线、霓虹倒映在水洼里 |
| 人物快速移动 | 骑车人蹬了三下、刹车、停在斑马线前 |
| 电影感 | 变形宽银幕镜头、浅景深、体积光 |
| 悲伤的音乐 | 慢速大提琴长音，尾音渐弱 |
| 好看的教室 | 掉漆的木课桌、黑板上的粉笔字、窗台上的搪瓷杯 |

## 3. 运镜语法（类型 + 幅度 + 速度）

- 类型：`Static / Push In / Pull Out / Pan L-R / Truck L-R / Tilt U-D / Pedestal U-D / Zoom In-Out / Arc / Tracking / Handheld / POV / Roll`。
- 幅度：`small amplitude / large amplitude`（中等省略）；速度：`slow / fast`（正常省略）。
- 写成句子融入镜头，不要句尾堆标签：
  `The camera pushes in with small amplitude at slow speed toward the letter in her hands.`
- **首帧图生视频（i2v）**：模型已经看得到画面 → **只写"动作 + 运镜 + 光线变化"，不要重复描述画面内容**（重复会浪费预算并引发漂移）。

## 4. 动作节奏（适配 4-15 秒）

- 一个主运动 + 一个环境次级运动是甜点区；三个以上运动会互相竞争、出现畸形。
- 想控制节奏用副词与顺序词：`slowly / gently / then / as / while / after a beat`。
- 长于 8 秒：按"起 → 承 → 转"写小小叙事，别堆动作清单。

## 5. 多镜/切镜（如需一镜多拍）

- **本项目"按场景组织、按镜生成"**：场景（Scene）= 地点+时间+氛围+道具+场景参考图；镜（Shot）挂在场景下，一场景多镜。
- **同场景一致性**：同一场景的所有镜头复用同一张**场景参考图**、同一**光线**（由场景 time_of_day 决定）、同一**氛围**与**道具**、同一**风格**——只改动作与运镜。换场景才换参考图/光线/道具。这是场景内不"跳戏"的关键。
- **逐镜生成（默认）→ 不写任何时间码**，也不写"第1秒/第2秒"；提示词从 `[Shot 1]` 开始即可（Shot 1 官方也不允许带时间码）。
- 只有**把同一场景的多个节拍合并成一条视频**（可选策略，单条 ≤ 15 秒）时，才从第 2 拍起写递增切镜时间：`[Shot 2] At 00:03.500, cut to ...`（格式 `MM:SS.mmm`，落在片长内）。
- 每块一个机位 + 一个动作 + 一个光线配方。
- 普通切镜用 `cut to`；只有明确需要过场才用 dissolve/fade/wipe。

## 6. 声音（支持原生音频的模型）

- 对白给说话人与口吻，台词逐字给原文；音效/环境声给具体名词（雨点打在铁皮棚、粉笔哒哒、远处的狗叫）。
- 模型不生成声音时忽略本节（不要浪费字数）。

## 7. 负面约束（少量、必要）

`no text, no watermark, no extra fingers, no deformed face, no flicker, no sudden zoom`
——只写"要避免的可见缺陷"，不要长篇负面清单（会稀释正向指令）。

## 8. 收录自查（生成前 30 秒过一遍）

1. 六要素齐了吗？缺哪个会随机。
2. 有没有空词（beautiful / cinematic / 高级感）能换成具体名词？
3. 运镜写了类型+幅度+速度吗？
4. 动作是不是只有一个主运动？
5. i2v 是否误描述了已存在的画面？
6. 时长/节奏与目标秒数匹配吗？
7. 用了参考图吗？用了就在提示词里点明"与参考图同一角色/同一场景"，一致性会明显更稳。

## 9. 兜底模板（直接填槽）

**人像/情绪**
```text
Medium close-up, slow push-in with small amplitude, a young woman with a low ponytail and dark blue jacket sits by a classroom window, exhales slowly and lifts her gaze to the light, warm golden dusk light from the left stays constant, soft chalk dust drifting in the beam, 2D celshu animation style, shallow depth of field.
```

**场景/环境**
```text
Wide shot, static camera, an empty village classroom at dusk, worn wooden desks and chalk handwriting on the blackboard, a tin cup on the windowsill, warm low sun raking through the windows with visible dust, painterly 2D animation background.
```

**动作/战斗**
```text
Low-angle tracking shot at fast speed, a swordsman in tattered white robes dashes across a rain-soaked stone bridge, one clean slash sends droplets flying while his robe whips behind him, cold backlight through rain, high-contrast 2D animation with motion blur on the blade.
```

## 10. 与专用技能的关系

- **MiniMax H3**（AutoDL H3 / MiniMax H3 源）：请用 `minimax-h3-prompt` 技能的三字段结构（本技能的六要素填进 `integrated_multimodal_description` / `overall_soundscape` / `non_diegetic_music`）。
- 其他模型（ComfyUI 工作流、Kling、Seedance、Wan、MiniMax v1 等）：本技能即最终格式。
- 一键成片兜底：`onekey_shot_video` 在 Agent 未提供 `prompt_override` 时会自动按本技能六要素组装基础提示词（主体+动作+环境+光线+运镜+风格）；**想更好就让 Agent 先 read_skill 再写 override**。
