---
name: jianyin-auto-assembly
description: 剪映多轨漫剧自动精修与花字字幕合成技能。调用 pyJianYingDraft 自动计算全片配音时长、对齐多轨并添加动态气泡与转场特效。
version: 1.0.0
author: pyJianYingDraft Studio
category: video_assembly
tools:
  - export_jianyin_draft
---

# 剪映多轨漫剧自动精修技能 (JianYing Auto Assembly)

## 技能定位与核心目标
一键打通 AI 分镜到剪映可编辑工程的最后一公里。通过 `pyJianYingDraft` 自动挂载主画面轨、角色对白轨、旁白轨与字幕花字轨。

## 技能执行 SOP 与工具调用链
1. **多轨时间戳计算**：
   - 提取所有分镜画面的持续时间，计算当前累计微秒数（Microseconds）。
2. **文本花字与气泡注入**：
   - 自动为每个台词片段匹配剪映“文轩体”，设置屏幕下方纵向坐标偏移（`-0.75`）。
   - 注入漫剧专属对话气泡效果。
3. **调用剪映导出 MCP (`export_jianyin_draft`)**：
   - 自动生成 `DraftFolder` 并输出 `draft_content.json` 与素材索引文件。
