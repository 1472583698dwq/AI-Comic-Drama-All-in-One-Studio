---
name: prompt-cinematic-boost
description: 画面提示词电影感润色。自动为生图/视频提示词注入电影级光影、构图与镜头语言，提升成片质感。
version: 1.0.0
author: MiniMax Studio
category: prompt_optimization
tools:
  - generate_image
---

# 提示词电影感润色 (Cinematic Boost)

## 技能定位
将用户输入的朴素画面描述润色为符合 MiniMax / ComfyUI 生图引擎偏好的电影级英文提示词，自动追加光影、材质与构图标签。

## 执行 SOP
1. **语义解析**：提取主体、动作、环境、情绪
2. **电影化注入**：追加 `cinematic lighting, volumetric lighting, ultra detailed, 8k, masterpiece, depth of field, film grain` 等标签
3. **构图优化**：根据景别自动补充 `rule of thirds, dramatic composition, leading lines`
4. **输出**：返回优化后的英文提示词，保持原意不变
