# MiniMax AI 漫剧 Studio (Desktop + Mobile 双端跨平台工作台)

> **深度融合**：**字节跳动·小云雀AI**（长文小说拆解与一致性流水线） + **MiniMax Design**（3D 虚拟导演台与多模态 Agent 协作） + **OpenReel Video**（专业多轨剪辑引擎） + **MCP (Model Context Protocol)** 统一外部工具扩展标准。

---

## 🌟 核心特性矩阵

### 1. 🖥️ 桌面专业版 (Desktop Studio)
- **3D 虚拟导演台 (MiniMax Design 核心创新)**：
  - 基于 Three.js 60fps 实时渲染，3D 虚拟空间摆放角色素体、姿态控制（武道战斗、傲然站立、回眸、奔跑）。
  - 自由调整机位与镜头轨迹（急进推镜、渐远拉出、360° 环绕、战斗震颤），导出空间强控参数（ControlNet / CameraCtrl Ready）。
- **专业多轨音视频剪辑时间线 (OpenReel 架构)**：
  - 包含：主画面轨、角色对白轨（波形可视化 + 情绪标签）、史诗旁白轨、BGM 氛围音效轨、动态花字字幕轨。
  - 帧级拖拽、时间线平滑缩放、实时吸附与音画对齐播放。
- **全生命周期角色一致性资产库 (Character Consistency Studio)**：
  - 标准人物正面 (0°)、侧面 (90°)、3/4 动态视角三视图管理。
  - 角色服饰、面部与特征词锁定（IP-Adapter / LoRA 权重绑定）。

### 2. 📱 移动便携版 (Mobile Quick App - 小云雀卡片流)
- **长篇小说一键成片**：支持整章网文粘贴，大模型秒级提炼人物关系与分镜。
- **全屏 9:16 卡片流工作台**：上下滑动逐镜微调，单手点击一键【换图】、【换声线】、【改台词】、【智能重绘】。
- **一键分发与成片**：支持竖屏短剧即时预览与快速成片导出。

### 3. 🔌 MCP (Model Context Protocol) 统一外部工具扩展体系
- **标准开放协议**：双端内置 MCP 客户端，支持一键调用与接入外部生态：
  - `split_novel_script`: 小说长文本章节拆解与角色提取 Agent Tool。
  - `generate_minimax_voice`: MiniMax Speech-01 超拟人配音 Tool（支持怒吼、低语、哭腔等情感）。
  - `director_3d_stage_plan`: 3D 虚拟导演台空间轨迹计算 Tool。
  - `comfyui_render_node`: 桥接用户本地/云端 ComfyUI (Flux/SDXL/ControlNet) 生图工作流。
  - `export_jianyin_draft`: 剪映 / CapCut 官方草稿工程 (`draft_content.json`) 一键导出 Tool。
- **自定义 MCP 插件市场**：支持用户自由添加自定义外部 MCP Server（如自建知识库、音效搜索、Web Search 等）。

---

## 🛠️ 技术栈架构

```mermaid
graph TD
    subgraph 客户端 (跨端统一)
        A1[React 19 + TypeScript + Vite]
        A2[Tailwind CSS v4 暗黑工业风设计系统]
        A3[Three.js 3D 导演台引擎]
        A4[Tauri 2.0 Rust 跨端运行时 Desktop/Mobile]
    end

    subgraph 后端与工具调度
        B1[Python FastAPI 异步高性能服务]
        B2[FastMCP 标准 Model Context Protocol 中枢]
        B3[MiniMax API 驱动: abab LLM + Speech-01 + Video-01]
        B4[剪映 / CapCut Draft Exporter v3]
    end

    A1 --> A2 & A3 & A4
    A1 <-->|RESTful API + WebSocket| B1
    B1 --> B2 --> B3 & B4
```

---

## 🚀 快速启动指南

### 方式一：Windows 一键启动（推荐）
双击项目根目录下的 **`start_all.bat`** 即可自动启动后端与客户端！

### 方式二：手动分步启动

#### 1. 启动 Python 后端服务
```bash
cd server
python run_server.py
```
> 后端服务运行于 `http://127.0.0.1:8000`，API 文档地址：`http://127.0.0.1:8000/docs`

#### 2. 启动前端客户端
```bash
cd client
npm run dev
```
> 客户端运行于 `http://localhost:5173`

---

## 📂 项目工程目录

```text
d:/ai漫剧/
├── client/                           # 双端跨平台前端 (React 19 + Vite + Tailwind + Three.js)
│   ├── src/
│   │   ├── components/
│   │   │   ├── navbar/Header.tsx     # 顶部多端切换与全局控制器
│   │   │   ├── director3d/           # [MiniMax Design] 3D 虚拟导演台 (Three.js)
│   │   │   ├── timeline/             # [OpenReel] 多轨音视频剪辑时间线
│   │   │   ├── storyboard/           # 分镜工作台与参数检查器
│   │   │   ├── character/            # 角色三视图一致性资产库
│   │   │   ├── mobile/               # [小云雀风格] 移动端全屏卡片流
│   │   │   ├── agent/                # 导演 Agent 对话交互抽屉
│   │   │   ├── mcp/                  # MCP 外部工具管理与沙盒测试弹窗
│   │   │   └── export/               # 剪映草稿与成片导出中心
│   │   ├── stores/                   # Zustand (useProjectStore, useMcpStore)
│   │   ├── services/                 # API 通信层
│   │   └── types/                    # TypeScript 类型定义
│   └── package.json
├── server/                           # 后端与 AI 调度中枢 (FastAPI + FastMCP)
│   ├── app/
│   │   ├── api/routes.py             # REST API 与 WebSocket 路由
│   │   ├── mcp/server.py             # MCP 统一工具注册中枢 (ComfyUI/剪映/MiniMax)
│   │   ├── pipelines/
│   │   │   ├── script_agent.py       # 小说智能拆解与角色提取 Agent
│   │   │   ├── minimax_tts.py        # MiniMax Speech-01 超拟人配音流水线
│   │   │   ├── consistency_engine.py # 角色三视图与场景一致性引擎
│   │   │   └── jianyin_exporter.py   # 剪映 / CapCut 官方草稿工程导出器
│   │   ├── core/config.py            # 环境与配置
│   │   └── main.py                   # FastAPI 应用入口
│   ├── run_server.py
│   └── requirements.txt
├── start_all.bat                     # Windows 一键启动脚本
└── README.md
```
