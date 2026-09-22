---
name: jianyin-auto-assembly
description: 剪映多轨漫剧草稿装配技能。按素材真实时长把分镜时间线导出为剪映/CapCut 官方草稿工程，并回报逐镜入轨/跳过情况。
version: 1.1.0
author: pyJianYingDraft Studio
category: video_assembly
tools:
  - export_jianyin_draft
---

# 剪映多轨漫剧自动装配技能 (JianYing Auto Assembly)

## 技能定位与核心目标
打通 AI 分镜到剪映可编辑工程的最后一公里：主画面轨、配音轨、字幕轨，以及绑定过 BGM 时的音乐轨。

## 时间线口径（导出器实际执行规则，不要对外宣称别的能力）
1. **素材真实时长优先**：静帧（png/jpg）可延长以覆盖整句配音；视频素材不冻帧，超出镜头槽位的部分被裁掉；
   镜头没有任何画面时，槽位让给配音。
2. **缺素材不静默**：既无画面也无配音的镜头整条跳过，并出现在回执的 `skipped_shots` 与 `warnings` 中，
   绝不推进游标把后面的配音错压到别的镜头上。
3. **只建有内容的轨**：轨道顺序自下而上为 `main_video` → `dialogue` → `bgm` → `captions`；
   `bgm` 仅当项目绑定了 `bgm_url` 时才存在，按素材长度平铺到全片末尾并带首尾淡入淡出。
4. **素材侧**：`/storage/`、`/exports/` 路径被限制在对应目录内；远端素材一次导出只取一次，跨导出按 URL 哈希复用缓存。

## 执行步骤
1. 取完整 Project JSON（含 `scenes[].shots[]` 的 `image_url/video_url/audio_url/subtitle_text/duration`）。
2. 调用 MCP 工具 `export_jianyin_draft`（参数 `project`）。
3. 读回执并向用户如实汇报：`tracks`、`duration_seconds`（实长）与 `design_duration_seconds`（设计）、
   `placed_shots/total_shots`、`skipped_shots`、`warnings`（截断/加载失败逐条原因）、`export_dir`。

## 明确不支持（需要人在剪映里做）
转场、花字/气泡样式、字幕入场动画、变速、音量包络、画面关键帧。当前导出只保证「素材按真实时长各就其位」。
