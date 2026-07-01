# SimpleMcpServer

让 AI 代理（Claude Code、Cursor 等）通过 MCP 协议直接操作 Unity 场景。

## 架构

```
AI Agent (Claude Code / Cursor)
    │  MCP (stdio)
    ▼
MCP Server (Node.js/TypeScript)   ← 本仓库
    │  WebSocket (JSON-RPC)
    ▼
Unity Bridge (C#)                 → SimpleMCPBridge/Assets/
    │
    ▼
Unity Editor / Runtime
```

- **MCP Server** — 处理 MCP 协议，注册工具，转发请求到 Unity
- **Unity Bridge** — 在 Unity 内运行的 WebSocket 服务器，执行场景操作

## 前置条件

- **Node.js 22+** — 内置 WebSocket 支持，无需 `ws` 库
- **Unity 2022.3+** — 项目已安装 SimpleMCPBridge 包
- **npm** — 随 Node.js 一起安装

验证 Node.js 已安装：

```bash
node --version   # 应输出 v22.x.x 或更高
npm --version    # 应输出 10.x.x 或更高
```

## 安装与设置

### 方式一：自动安装（推荐）

双击运行 `setup.bat`，它会自动检查环境并安装依赖。

### 方式二：手动安装

```bash
cd SimpleMcpServer
npm install
npm run build
```

## 使用

### 1. 启动 Unity Bridge

1. 用 Unity 打开项目
2. 菜单栏 → **Tools → SimpleMCPBridge**
3. 点击 **Start Bridge**（默认端口 45678）

或在 Unity 启动时自动启动（已配置 `Assets/SimpleMCPBridge/Editor/AutoStartBridge.cs`）。

### 2. 启动 MCP Server

```bash
# 编译 + 启动（双击 start.bat）
start.bat

# 或跳过编译直接启动（代码未改时）
start-quick.bat
```

服务器连接到 Unity 后输出：

```
[MCP-Server] Connected to Unity!
[MCP-Server] Ready. Agent can now use Unity tools via MCP.
```

### 3. 配置 AI 代理

#### Claude Code

在项目根目录的 `claude.json` 或 `CLAUDE.md` 中添加：

```json
{
  "mcpServers": {
    "unity": {
      "command": "node",
      "args": ["path/to/SimpleMcpServer/dist/index.js"]
    }
  }
}
```

#### Cursor

在 Settings → MCP 中添加：

```
名称: Unity
类型: command
命令: node path/to/SimpleMcpServer/dist/index.js
```

### 4. 验证连通性

```bat
# 双击 start-test.bat
start-test.bat
```

预期输出：全部 6 项测试通过。

## 可用工具

| 工具 | 说明 |
|------|------|
| `scene.get_hierarchy` | 获取场景层级树（根对象 → 子对象） |
| `scene.get_objects` | 获取所有对象，可选按名称过滤 |
| `scene.create_object` | 创建 GameObject，可设位置/旋转/缩放 |
| `scene.delete_object` | 按 instanceId 删除对象 |
| `scene.set_transform` | 修改对象的位置/旋转/缩放 |
| `scene.set_component_property` | 修改组件属性（支持 Vector3、Color 等类型） |

## 配置

通过环境变量 `UNITY_MCP_PORT` 修改端口（默认 45678）：

```bash
set UNITY_MCP_PORT=45679 && node dist/index.js
```

## 开发

```bash
# 监听模式开发
npm run dev       # 使用 tsx 直接运行 TS

# 测试
start-test.bat    # 或 node tests/test-bridge.mjs

# 目录结构
src/              # TypeScript 源码
├── index.ts          # 入口
├── unity-bridge.ts   # WebSocket 客户端
├── types.ts          # 类型定义
└── tools/
    └── scene-tools.ts  # 工具注册
tests/              # 测试代码
├── test-bridge.mjs    # 主 E2E 测试
├── test-simple.mjs    # 连通性测试
└── diff-test.mjs      # 诊断工具
```

## 故障排查

**"Failed to connect to Unity"**
→ Unity 没打开，或 SimpleMCPBridge 没启动
→ 确保 Unity 菜单栏 Tools → SimpleMCPBridge → Start

**"Connection refused"**
→ 端口被占用，或 Unity 桥接器未运行
→ 重启 Unity Bridge（Stop → Start）
→ 或修改端口：`set UNITY_MCP_PORT=45679`

**测试超时**
→ Unity Bridge 在 Edit Mode 下未处理消息
→ 确保 `AutoStartBridge.cs` 已生效（检查 Console 日志）

## 技术说明

- Unity Bridge 使用纯 TCP 实现 RFC 6455 WebSocket，零外部依赖
- MCP Server 使用 `@modelcontextprotocol/sdk` v1.x 与 `StdioServerTransport`
- 消息队列在主线程上处理（`EditorApplication.update`），保证 Unity API 安全
- 日志输出到 Unity 项目根目录的 `Logs/mcp_bridge_debug.log`
