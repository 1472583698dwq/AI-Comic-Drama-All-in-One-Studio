# AGENTS.md

## 开发运行（默认方式，不构建）

- 后端：在 `server` 目录运行 `python run_server.py`（127.0.0.1:8000，uvicorn reload）
- 前端：在 `client` 目录运行 `npm run dev`（http://localhost:5173，Vite 热更新）
- UI 验证一律用 **http://localhost:5173**；`8000` 只提供 API 与上次构建的 `client/dist`（旧界面），不要用它判断新代码是否生效。

## 约定

- 除非用户明确要求发布/打包，不要执行 `npm run build`、桌面打包（`build_*.py` / `Studio.spec`）或重建安装包。
- 改完前端代码直接刷新 5173 即可；改完后端由 reload 自动生效。
- 验证最少跑：`npx tsc -b`（client）与 `npm test`（client）；后端按改动范围跑对应 unittest。
