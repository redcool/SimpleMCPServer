# 架构与目录

## 运行时边界

```text
AI client --MCP Streamable HTTP/SSE--> server.ts
                                      ├─ tools.ts：合并工具清单
                                      ├─ bridgeState.ts：Bridge 状态、路由、pending 请求
                                      ├─ mcpAdapter.ts：外部 MCP 子进程（stdio）
                                      ├─ src/blender/：Blender adapter、模板、高级、manifest、walk 和 Action 兼容层
                                      ├─ src/unreal/：预留 Unreal MCP adapter 分层
                                      └─ ab.ts：AssetBundle 文件中转
Unity/Godot Bridge --WebSocket----------------^
```

`src/index.ts` 只负责启动 `server.main()`；Server 的 HTTP 和 WebSocket 共用端口（默认 45678）。外部 adapter 的 stdio 是 Server 作为 MCP Client 的下游连接，不是 AI 客户端连接本 Server 的方式。

## 工具合并与路由

`getMergedTools()` 按服务端工具、adapter、内置 Blender 工具、Bridge 工具合并，并按名字去重；adapter 命名空间优先。`allowedTools` 过滤暴露清单。Bridge 使用最后注册目标路由；具体 Bridge 工具数量取决于连接的 Bridge。

`evalEnabled=false` 同时隐藏并拒绝 `editor.eval`、危险 adapter 工具和内置 Blender 代码执行工具。不要把“列表隐藏”当作唯一安全边界；调用路径也执行检查。

## 目录约定

| 路径 | 用途 |
|---|---|
| `src/` | TypeScript 运行时源码 |
| `tests/` | Node test 回归、源码静态检查和需外部服务的 E2E 脚本 |
| `docs/` | 当前指南与专题文档；`docs/archive/` 只放历史快照 |
| `scripts/` | 外部工具/Blender 启动辅助脚本 |
| `testTools/` | 人工或平台测试辅助脚本 |
| `mcp-media/` | adapter 返回的截图等运行产物，忽略提交 |
| `ab-cache/` | AssetBundle 运行缓存，忽略提交 |
| `dist/` | TypeScript 构建产物，忽略提交 |
| 根目录 `*.blend`、临时 Python | 工作素材；除非明确是测试夹具，不应混入 Server 提交 |

## 当前入口

- `GET/POST /mcp-stream`：推荐 MCP 传输。
- `GET /sse` + `POST /mcp?sessionId=...`：兼容 SSE。
- `POST /rpc`：直接 JSON-RPC，主要供脚本和测试。
- `GET /health`：状态检查。
- WebSocket：Bridge 连接。