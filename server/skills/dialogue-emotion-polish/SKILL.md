---
name: dialogue-emotion-polish
description: 台词情绪润色。自动为对白注入情绪标签、节奏与标点，提升配音表现力。
version: 1.0.0
author: MiniMax Studio
category: prompt_optimization
tools:
  - generate_voice
---

# 台词情绪润色 (Dialogue Emotion Polish)

## 技能定位
将平淡的对白润色为更具张力的台词，自动匹配 MiniMax Speech-01 的 emotion 参数。

## 执行 SOP
1. **情绪识别**：愤怒/悲伤/兴奋/平静/耳语
2. **文本润色**：调整标点、重复、语气词（如“！！”“……”）
3. **标签输出**：返回 `polished_text` 与 `suggested_emotion`（neutral/intense/sorrow/excited/whispering）
4. **示例**：输入“这一世我命由我不由天” → 输出“这一世——我命由我，不由天！！” + intense
