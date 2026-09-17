# AGENTS.md — SimpleMcpServer 项目知识库

> 开始任务前阅读本文件。凡涉及功能、协议、工具、配置、测试或运行方式的变更，完成后必须更新本文件，并修改“最后更新”。
>
> 最后更新：2026-09-15（Blender 代码归档至 src/blender，统一工具注册并规划 Unreal 适配器分层）

## 项目定位

Node.js + TypeScript MCP Server：向 AI Agent 提供 MCP 工具；通过 WebSocket 转发 Unity/Godot Bridge；作为 MCP Client 接入外部 MCP Server（当前重点 BlenderMCP）；提供 SSE、Streamable HTTP、直接 JSON-RPC、认证/IP 白名单、资源限制、加密和危险工具门控。

本仓库不包含 Unity/Godot Bridge、Blender Add-on 或 Unreal MCP Server 本体。

## 环境与路径

- Server：H:\ai_works\SimpleMcpServer
- Unity Bridge：H:\ai_works\SimpleMCPBridge
- Godot Bridge：H:\ai_works\SimpleMcpBridge_Godot
- 游戏工程：H:\Works\FeiTuTeamPrj
- Blender：H:\Program Files\blender-5.2.0-windows-x64
- Blender：5.2.0 LTS；Unity 实测 2022.3.62f2；Godot 实测 4.7 stable mono
- Blender MCP：blender-mcp@1.9.1
- Server 端口：45678；Blender 默认端口：9876，第二实例通常 9877

## 构建、测试、入口

```powershell
npm run build
npm test
npm start
```

`npm test` = TypeScript build + `node --test tests/*.test.cjs`。

- 推荐 MCP：GET/POST `/mcp-stream`
- 兼容 SSE：GET `/sse` + POST `/mcp?sessionId=...`
- 测试/脚本：POST `/rpc`
- 健康检查：GET `/health`
- Bridge：WebSocket `ws://<ip>:45678/`

## 配置与安全规则

- `config.json` 含本机配置/密钥，默认 gitignored；未经用户明确要求不修改、不提交、不输出密钥。
- `config.json.template` 必须同步新增配置字段。
- `allowedIps` 控制 Bridge 和 HTTP 访问；`authToken` 控制可选 Bearer 认证。
- `evalEnabled` 同时控制 `editor.eval`、外部 `*.execute_*`、Blender 模板和高级工具：工具列表隐藏 + 执行时拒绝。
- `allowedTools` 限制暴露工具；`limits` 限制 body、上传、AI prompt/context/concurrency 和工具参数。
- 外部 adapter 由 `src/mcpAdapter.ts` 管理生命周期、工具枚举、调用、自动重连和 health。

## 代码入口

| 文件 | 职责 |
|---|---|
| `src/server.ts` | HTTP/WebSocket/MCP/RPC、路由、安全门控、健康检查 |
| `src/tools.ts` | 合并 Bridge、Adapter、Server 和 `src/blender/` 工具 |
| `src/mcpAdapter.ts` | 外部 MCP 子进程、调用、重连、health |
| `src/blender/blenderAdapter.ts` | Blender 代码执行的 adapter 选择、多实例路由和结果文本封装 |
| `src/blender/blenderActionCompat.ts` | Blender 旧式与 layered Action 曲线读取兼容 helper |
| `src/blender/blenderTemplateTools.ts` | 基础 Blender 模板 bpy 工具 |
| `src/blender/blenderAdvancedTools.ts` | IK、权重、PBR、动画、可靠性工具 |
| `src/blender/blenderExportValidation.ts` | Blender 导出 manifest 与比对 |
| `src/blender/blenderAnimWalkSetup.ts` | 非破坏性 Robot_Walk 设置 |
| `src/config.ts` | 配置、认证、IP、limits |
| `src/bridgeState.ts` | Bridge 状态、路由、pending 请求 |
| `tests/regression.test.cjs` | Server 安全和协议回归测试 |
| `tests/blender_pipeline.test.cjs` | Blender 工具源码静态测试 |
| `tests/blender_adapter.test.cjs` | Blender adapter 路由和 schema 静态回归 |
| `docs/blender-mcp-template-tools.md` | Blender 工具说明 |
| `session_memory.md` | 历史决策、坑和会话恢复信息 |
| `docs/README.md` | 当前文档索引与历史/当前边界 |
| `docs/architecture.md` | 运行时架构与目录约定 |
| `docs/configuration.md` | 配置、安全与限制 |
| `docs/integrations.md` | Unity/Godot/Blender 接入边界 |
| `docs/development.md` | 构建、测试与已知限制 |

## 目录分层

`src/blender/` 集中放置 Blender MCP 适配器路由、基础模板、高级工具、manifest、walk setup 和 Action 兼容代码。`src/unreal/` 预留 Unreal MCP 适配器，建议按同样边界拆分 `unrealAdapter.ts`、`unrealTools.ts`、`unrealAssetValidation.ts` 与能力模块；根目录仅保留跨平台 Server、Bridge、配置和 MCP 生命周期代码。

## Blender 工具清单
