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
2. 菜单栏 → **PowerUtilities → SimpleMCPBridge**
3. 点击 **Connect to Server**

Bridge 生命周期独立于窗口：关闭窗口后 bridge 继续运行，进出 Play Mode 自动重连（依赖 `[InitializeOnLoad]` + EditorPrefs 持久化标志）。

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
[Server] Registered 23 tool(s) from bridge [ID: xxxx]
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

## 对象寻址

Unity 侧的场景工具同时支持两种方式定位 GameObject：

| 参数 | 说明 |
|------|------|
| `instanceId` | Unity 实例 ID，精确唯一，但 domain reload 后失效 |
| `path` | Transform 路径（如 `"Canvas/Panel/Button"`），跨 domain reload 有效 |

解析优先级：`instanceId` > `path`。`get_hierarchy` 和 `get_objects` 的返回值同时包含两者。

## 可用工具（共 23 个）

### 场景工具（SceneHandler）

| 工具 | 说明 |
|------|------|
| `scene.get_hierarchy` | 获取场景层级树（含 path、instanceId、组件名、位置） |
| `scene.get_objects` | 查找对象，可选按 `nameContains` 过滤，返回 path + instanceId |
| `scene.create_object` | 创建 GameObject，支持 name / parentPath / position / rotation / scale |
| `scene.delete_object` | 按 instanceId 或 path 删除对象 |
| `scene.set_transform` | 按 instanceId 或 path 设置 position / rotation / scale |
| `scene.set_component_property` | 修改组件字段/属性，支持 Vector3、Color、Enum 等类型 |
| `scene.get_components` | 按 instanceId 或 path 获取 GameObject 所有组件列表 |
| `scene.get_component_properties` | 获取组件所有可序列化属性名和当前值 |
| `scene.set_active` | 按 instanceId 或 path 启用/禁用 GameObject |
| `scene.duplicate_object` | 按 instanceId 或 path 复制 GameObject |
| `scene.rename` | 按 instanceId 或 path 重命名 GameObject |
| `scene.set_parent` | 按 instanceId/path 设置父级，`parentPath`/`parentId` 指定父对象（留空则解除到根） |
| `scene.add_component` | 按类型名添加组件（如 Rigidbody） |
| `scene.instantiate_prefab` | 按 assetPath 实例化预制体到场景，支持 transform 和 parent（仅 Editor） |
| `scene.set_material` ⚠ | 修改运行时材质颜色/纹理。资产级修改建议直接改 `.meta` GUID |
| `scene.enter_play_mode` | 进入播放模式（仅 Editor） |
| `scene.exit_play_mode` | 退出播放模式（仅 Editor） |
| `scene.pause_play_mode` | 暂停/继续播放模式 — 传 `paused: true/false`（仅 Editor） |
| `scene.get_play_mode` | 获取当前播放模式状态 — 返回 isPlaying/isPaused/mode（仅 Editor） |

### 资源工具（AssetHandler，仅 Editor）

| 工具 | 说明 |
|------|------|
| `asset.find_assets` | 按名称和/或类型搜索项目 Assets。参数：`nameContains`（可选）、`typeFilter`（可选，如 `"Prefab"`、`"Material"`）。返回 `{path, name, type, guid}` 列表 |
| `asset.find_references` | 查找引用了指定资源的所有资源（反向依赖）。参数：`assetPath`（必填）。扫描文件内容中的 GUID，返回引用者列表。可靠但较慢 |

### 编辑器工具

| 工具 | 说明 |
|------|------|
| `editor.request_compile` | 触发 Unity 脚本重新编译（外部修改 C# 后用）（仅 Editor） |
| `editor.open_window` | 按菜单路径打开 Unity Editor 窗口，如 `"Window/General/Console"`（仅 Editor） |

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
├── test-e2e.cjs           # E2E 测试（initialize + tools/list + get_hierarchy）
└── test-playmode-cycle.cjs # Play Mode 循环测试（进出播放验证 bridge 自动重连）
```

## 故障排查

**"WebSocket server error: listen EADDRINUSE"**
→ 端口被占用，杀掉残留进程：
```powershell
Get-Process -Name "node" | Stop-Process -Force
```

**"Unity not connected"**
→ Unity 没打开，或 SimpleMCPBridge 没启动

**Bridge 进出 Play Mode 后断连**
→ 确认 Unity 菜单 `Edit → Project Settings → Editor → Enter Play Mode Settings` 中 `Reload Domain` 已开启。Bridge 依赖 `[InitializeOnLoad]` 在 domain reload 后重新订阅 `EditorApplication.update`。如关闭 Domain Reload，Bridge 连接会在 Play Mode 期间保持，但退出后无法自动重连。

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
- Server 同时暴露 HTTP `/rpc` 端点用于程序化调用（E2E 测试使用）
- `/health` 端点返回 bridge 连接状态、工具列表、播放模式状态
