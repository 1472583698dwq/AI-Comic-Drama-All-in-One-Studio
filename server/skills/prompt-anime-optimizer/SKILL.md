---
name: prompt-anime-optimizer
description: 二次元/国漫风格提示词优化。自动转换为日式二次元或国漫仙侠专用提示词结构。
version: 1.0.0
author: MiniMax Studio
category: prompt_optimization
tools: []
---

# 二次元风格优化 (Anime Optimizer)

## 技能定位
将通用描述转换为适配二次元/国漫生图模型的提示词，自动处理风格后缀与负向提示。

## 执行 SOP
1. **风格识别**：判断 donghua_xianxia / japanese_anime / cinematic_3d
2. **标签转换**：追加 `anime style, studio ghibli, makoto shinkai, vibrant colors` 或 `guofeng, xianxia, ink painting, ethereal`
3. **负向优化**：自动补充 `low quality, blurry, deformed` 等负向
4. **输出**：返回风格化提示词
