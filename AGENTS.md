# AGENTS.md — SimpleMcpServer 项目知识库

> 开始任务前阅读本文件。凡涉及功能、协议、工具、配置、测试或运行方式的变更，完成后必须更新本文件，并修改“最后更新”。
>
> 最后更新：2026-10-22（文档改为相对路径：组件与 hub 同级（`../SimpleMCPBridge`、`../SimpleMCPBridge_Godot`、`../SimpleAIBrain`、本仓库 `unreal5/`）；AGENTS/README 组件清单补齐；适配 `docsRules/` 纪律目录重组并修复 6 处断链、登记两份纪律文档；记忆系统接入：身份 s1/local/simplemcpserver，`.brain.json` 已 gitignore；此前 2026-10-15 llm 渠道回退链）

## 项目定位

> 2026-10-15：`callLLM` 支持渠道回退链（`llm.fallbacks`，≤3，按序尝试，对插件透明）。换信任的 LLM = 改 `config.json` 的 `llm` 段，见 docs/configuration.md「llm 渠道链」。

Node.js + TypeScript MCP Server：向 AI Agent 提供 MCP 工具；通过 WebSocket 转发 Unity/Godot Bridge；作为 MCP Client 接入外部 MCP Server（当前重点 BlenderMCP）；提供 SSE、Streamable HTTP、直接 JSON-RPC、认证/IP 白名单、资源限制、加密和危险工具门控。

本仓库不包含 Unity/Godot Bridge、Blender Add-on 或 Unreal MCP Server 本体。

## 组件与路径约定

所有配套组件与本仓库**同级**（同一个父目录）。文档只用相对路径，不写死本机绝对路径。

| 组件 | 相对位置 | 作用 |
|---|---|---|
| SimpleMcpServer（本仓库） | `.` | hub：HTTP/WebSocket/MCP/RPC，端口 45678 |
| SimpleMCPBridge | `../SimpleMCPBridge` | Unity Bridge，UPM 包，WebSocket 注册工具 |
| SimpleMCPBridge_Godot | `../SimpleMCPBridge_Godot` | Godot Bridge，addons 插件，WebSocket 注册工具 |
| SimpleAIBrain | `../SimpleAIBrain` | 记忆系统（ai-brain 插件），提供 `memory.*`；凭据 `.brain.json` |
| unreal5 | 本仓库 `unreal5/` | Unreal C++ 插件源码（MCPUnrealBridge）+ Python + 同步脚本 |
| Blender MCP | 外部依赖 | `blender-mcp` 进程 + Blender Add-on，非本仓库组件 |

- 版本实测：Blender 5.2 LTS；Unity 2022.3.62f2；Godot 4.7 stable mono；blender-mcp@1.9.1。
- 端口：Server 45678；Blender Add-on 默认 9876，第二实例通常 9877。
- 引擎安装目录、游戏工程目录属本机环境，不写默认值；需要时向用户确认。

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
| `src/unreal/` | Unreal MCP 路由、只读能力、资产/job、Level/Actor/材质/动画、pipeline、fracture 方案 C 工具 |
| `tests/regression.test.cjs` | Server 安全和协议回归测试 |
| `tests/blender_pipeline.test.cjs` | Blender 工具源码静态测试 |
| `tests/blender_adapter.test.cjs` | Blender adapter 路由和 schema 静态回归 |
| `tests/blender_adapter_behavior.test.cjs` | Blender adapter 选择和 MCP/RPC 结果行为回归 |
| `tests/blender_action_compat.test.cjs` | Blender 5.2 隔离 Action/manifest 集成验证 |
| `docs/blender-mcp-template-tools.md` | Blender 工具说明 |
| `session_memory.md` | 历史决策、坑和会话恢复信息 |
| `docs/README.md` | 当前文档索引与历史/当前边界 |
| `docs/architecture.md` | 运行时架构与目录约定 |
| `docs/configuration.md` | 配置、安全与限制 |
| `docs/integrations.md` | Unity/Godot/Blender 接入边界 |
| `docs/development.md` | 构建、测试与已知限制 |
| `docsRules/Agent工作纪律.md` | 工作纪律：版本号与 z 升版判定、.trash/tmp、写作与沟通纪律 |
| `docsRules/Agent代码工程纪律.md` | 代码工程纪律：架构/KISS、先读后写、最小修改、测试铁律、安全红线、交付格式 |

## 目录分层
## 记忆系统使用(由 enroll.mjs 生成,0.0.16.13)
> 开始任务前:读本目录 `.brain.json` 取 token → 调用 hub(默认 127.0.0.1:45678,以部署实际为准)的 `memory.context`,**token 作为工具参数 `_brainToken` 传入**(不是 HTTP Bearer 头)。可先 `memory.whoami` 验证身份。不带 token = 访客,只看 studio 作用域,0 命中不代表没记忆。
> 会话结束(或用户说"存储记忆"):调 `memory.submit_session`,`session_id`=当前会话 id,`kind`="digest",`content`=本会话关键决定与新知识(400-1200 字,带出处,不含密钥)。
> 用户口令全表(存储记忆/获取记忆/查找记忆/记忆体检/登记记忆):<SimpleAIBrain>/docs/用户指令.md(部署约定:SimpleAIBrain 与 SimpleMcpServer 为同根兄弟目录;或设环境变量 SIMPLEAIBRAIN_HOME 指向 SimpleAIBrain 仓库)。
> 不要直接读记忆库数据文件当记忆来源——只有走工具才有正确的可见性与脱敏。
> 记忆之门 = hub(SimpleMcpServer,127.0.0.1:45678)。调用 memory.* 报 ECONNREFUSED/fetch failed = 门没开:向用户报告,由用户在**可见 cmd 窗口**启动 hub(启动与核对方法见 <SimpleAIBrain>/docs/用户指令.md(部署约定:SimpleAIBrain 与 SimpleMcpServer 为同根兄弟目录;或设环境变量 SIMPLEAIBRAIN_HOME 指向 SimpleAIBrain 仓库)「记忆之门」节);agent 不应私自后台拉起 hub。
