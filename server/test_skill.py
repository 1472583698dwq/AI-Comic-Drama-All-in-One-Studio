import sys
import os
import io
import asyncio

# Set stdout encoding to UTF-8
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

from app.skills.engine import skill_engine

async def main():
    print("================== Skill 技能引擎与工具调用测试 ==================")
    skills = skill_engine.list_skills()
    print(f"已自动发现并加载 {len(skills)} 个 Skill:")
    for s in skills:
        print(f"  * [{s.name}] (v{s.version}) - 绑定工具: {s.tools}")

    print("\n--- 正在触发执行 Skill: novel-climax-enhancer ---")
    context = {
        "dialogue": "这一世，我命由我不由天！",
        "character_name": "叶凡",
        "project_id": "test-proj-01"
    }
    result = await skill_engine.execute_skill("novel-climax-enhancer", context)
    print(f"执行状态: {result.status} (耗时: {result.execution_time_ms}ms)")
    print(f"返回消息: {result.result_message}")
    print("工具调用链记录 (MCP Tool Trace):")
    for tc in result.tool_calls:
        print(f"  -> [Tool: {tc['tool']}] 状态: {tc['status']} | 输出: {tc['result']}")
    print(f"修改后分镜数据: {result.modified_data}")
    print("=================================================================\n")

if __name__ == "__main__":
    asyncio.run(main())
