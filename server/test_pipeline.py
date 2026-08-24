import asyncio
from app.pipelines.unified_orchestrator import unified_orchestrator

async def main():
    text = "九龙拉棺降临泰山之巅。\n叶凡冷声道：这一世我命由我不由天！"
    res = await unified_orchestrator.execute_full_pipeline(text, "donghua_xianxia", "9:16")
    print("\n================== 漫剧统一编排流水线执行报告 ==================")
    print(f"执行状态: {res['status']}")
    print(f"总耗时: {res['execution_time_ms']} ms")
    print(f"生成分镜数: {res['total_shots']} 个")
    print(f"全片时长: {res['total_duration_seconds']} 秒")
    print("\n流水线 5 大阶段执行追踪:")
    for stage in res['pipeline_stages']:
        print(f"  [+{stage['time_ms']}ms] {stage['stage']}: {stage['message']}")
    print(f"\n剪映草稿生成状态: {res['jianyin_draft']}")
    print("=================================================================\n")

if __name__ == "__main__":
    asyncio.run(main())
