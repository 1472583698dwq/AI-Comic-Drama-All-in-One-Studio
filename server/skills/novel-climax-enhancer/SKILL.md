---
name: novel-climax-enhancer
description: 网文爽点与高潮重构技能。自动提炼网文核心冲突，增强分镜戏剧张力，并在关键镜头注入 MiniMax 怒吼/爆发配音与镜头震颤特效。
version: 1.0.0
author: MiniMax Studio
category: script_enhancement
tools:
  - split_novel_script
  - generate_minimax_voice
  - director_3d_stage_plan
---

# 网文爽点与高潮重构技能 (Novel Climax Enhancer)

## 技能定位与核心目标
当创作者导入长篇小说后，该技能负责识别剧情中的**“装逼打脸、绝境反击、宿命对决”**等核心高潮点，重构分镜节奏，增强视觉与听觉冲击力。

## 技能执行 SOP 与工具调用链
1. **剧情冲突分析**：
   - 遍历小说文本，定位情绪峰值最高的核心句子（如：“这一世，我命由我不由天！”）。
2. **视觉运镜升格 (调用 `director_3d_stage_plan`)**：
   - 将高潮分镜的景别强制设定为 `extreme_close_up`（眼神大特写）或 `low_angle`（仰角霸气全景）。
   - 运镜方式切换为 `shake`（战斗震颤）或 `push_in`（急进推进），素体姿态切换为 `fight`（武道战斗）。
3. **听觉情感爆发 (调用 `generate_minimax_voice`)**：
   - 调用 MiniMax Speech-01 模型，将配音情绪强制标记为 `intense`（怒吼/爆发）。
   - 提升语速至 1.1x，增强紧迫感。
4. **输出合成**：
   - 更新当前分镜的提示词与属性，并在多轨时间线上自动加粗高潮字幕花字。
