# SimpleMcpServer

让 AI 代理（Claude Code、OpenCode 等）通过 MCP 协议直接操作 Unity 场景。  
**必须配合 [SimpleMCPBridge](https://github.com/redcool/SimpleMCPBridge_Unity)（Unity 侧桥接包）使用。**

## 架构

```
AI Agent (Claude Code / OpenCode)
    │  MCP (stdio)
    ▼
SimpleMcpServer (Node.js/TypeScript)   ← 本仓库
    │  WebSocket
    ▼
SimpleMCPBridge (C#)                   ← 另一个仓库，需单独 clone 到 Unity Assets/
    │
    ▼
Unity Editor / Runtime
```

- **SimpleMcpServer**（本仓库）— 处理 MCP 协议，注册工具，转发请求到 Unity
- **SimpleMCPBridge**（[companion repo](https://github.com/redcool/SimpleMCPBridge_Unity)）— 在 Unity 内运行的 WebSocket 客户端，执行场景操作

## 前置条件

- **Node.js 22+**
- **Unity 2022.3+** — 项目已安装 SimpleMCPBridge 包
- **npm** — 随 Node.js 一起安装

验证 Node.js：

```bash
node --version   # 应输出 v22.x.x 或更高
npm --version    # 应输出 10.x.x 或更高
```

## 安装与设置

### 自动安装（推荐）

双击 `setup.bat`。

### 手动安装

```bash
cd SimpleMcpServer
npm install
npm run build
```

## 使用

### 前置：clone 并配置 SimpleMCPBridge

```bash
cd YourUnityProject/Assets/
git clone https://github.com/redcool/SimpleMCPBridge_Unity.git
```

编辑 `Assets/SimpleMCPBridge/bridge-config.json`：

```json
{ "serverIp": "127.0.0.1", "serverPort": 45678 }
```

### 1. 启动 Unity Bridge

1. 用 Unity 打开项目
2. 菜单栏 → **Tools → SimpleMCPBridge**
3. 点击 **Connect to Server**

或让 Unity 启动时自动连接（`AutoStartBridge.cs` 通过 `bridge-config.json` 自动连接）。

### 2. 启动 MCP Server

```bash
# 编译 + 启动
start.bat

# 跳过编译（代码未改时）
start-quick.bat
```

连接成功输出：

```
[Server] Bridge connected
[Server] Registered 6 tool(s) from bridge [ID: xxxx]
[Server] Ready (ws://127.0.0.1:45678)
```

### 3. 配置 AI 代理

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

### 4. 验证连通性

```bash
node tests/test-e2e.cjs
```

预期输出：`*** TEST PASSED ***`

## 可用工具

| 工具 | 说明 |
|------|------|
| `scene.get_hierarchy` | 获取场景层级树 |
| `scene.get_objects` | 按名称过滤查找对象 |
| `scene.create_object` | 创建 GameObject |
| `scene.delete_object` | 按 instanceId 删除 |
| `scene.set_transform` | 修改位置/旋转/缩放 |
| `scene.set_component_property` | 修改组件属性 |

## 配置

编辑 `config.json`：

```json
{ "ip": "127.0.0.1", "port": 45678 }
```

本地开发用 `127.0.0.1`，云端部署用 `0.0.0.0`。

## 开发

```bash
npm run dev           # tsx 监听模式
node tests/test-e2e.cjs  # E2E 测试

# 目录结构
src/
├── index.ts           # 入口 + WS Server + MCP handlers
└── types.ts           # 类型定义
tests/
└── test-e2e.cjs       # E2E 测试
```

## 故障排查

**"WebSocket server error: listen EADDRINUSE"**
→ 端口被占用，杀掉残留进程：
```powershell
Get-Process -Name "node" | Stop-Process -Force
```

**"Unity not connected"**
→ Unity 没打开，或 SimpleMCPBridge 没启动

**测试超时**
→ E2E 测试会启动自己的 Server 实例，Bridge 需要通过重试循环重连到新 Server

## 相关仓库

| 仓库 | 说明 |
|------|------|
| [SimpleMcpServer](https://github.com/redcool/SimpleMCPServer) | 本仓库 — MCP Server，Node.js 端 |
| [SimpleMCPBridge](https://github.com/redcool/SimpleMCPBridge_Unity) | Unity 桥接包，clone 到 Unity 项目的 `Assets/` 下 |

## 技术说明

- MCP SDK v1.x 低阶 API（`setRequestHandler`），不用 `registerTool()`（该 API 在 `connect()` 后抛出异常）
- WebSocket 通信（`ws` 库），IP/Port 来自 `config.json`
- 工具通过 `register_tools` 消息从 Bridge 动态注册到 Server，Bridge 重连后自动重新注册
- Unity Bridge 使用纯 TCP 实现 RFC 6455 WebSocket，零外部依赖
