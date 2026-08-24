import uvicorn
import os
import sys

# Ensure app path in sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

if __name__ == "__main__":
    print("[MiniMax AI 漫剧 Studio 后端服务启动中...]")
    print("访问 Swagger 文档: http://127.0.0.1:8000/docs")
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)
