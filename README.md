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

> **除桥外**，Server 也能作为 **MCP 客户端** 接入外部标准 MCP server（如 BlenderMCP），
> 把它们的工具以 `<前缀>.<工具名>` 暴露给 AI（如 `blender.get_scene_info`），见「外部 MCP 适配器」。

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

### 前置：安装 SimpleMCPBridge

```bash
cd YourUnityProject/Assets/
git clone https://github.com/redcool/SimpleMCPBridge_Unity.git SimpleMCPBridge
```

### 1. 启动 Unity Bridge（prefab 方式）

1. 用 Unity 打开项目
2. 将 `Assets/SimpleMCPBridge/Prefabs/MCPBridge.prefab` 拖入场景（或给任意 GameObject 添加 `MCPBridge` 组件）
3. 选中该对象，Inspector 顶部即显示连接状态（● Connected / ○ Disconnected）、`ws://ip:port`、Bridge ID 与 **Connect / Disconnect** 按钮
4. Server IP / Port 默认 `127.0.0.1:45678`，如需修改见下方 `bridge-config.json`

Bridge 通过 `[ExecuteAlways]` 在 Edit Mode、Play Mode、打包运行三态下均工作；默认 `isAutoReconnect=true`，场景加载、进出 Play Mode、脚本重编译（domain reload）后自动重连，无需手动操作。

#### bridge-config.json（可选，默认即可用）

Bridge 启动时自动加载配置——**配置文件不存在时，首次自动从包内 `Resources/bridge-config.json` 拷贝生成（已存在则不覆盖），改完需重启生效**：

| 环境 | 路径 |
|------|------|
| Editor | 项目 `Assets/SimpleMCPBridge-config/bridge-config.json` |
| Player | `Application.persistentDataPath/bridge-config.json` |
| 兜底 | 包内 `Resources/bridge-config.json`（内嵌默认值）|

```json
{ "serverIp": "127.0.0.1", "serverPort": 45678, "encryptionKey": "" }
```

- `serverIp`/`serverPort` — 与 Server 侧 `config.json` 的 `ip`/`port` 对应
- `encryptionKey` — 与 Server 侧 `encryptionKey` 一致时启用 AES-256-CBC 载荷加密；空 = 透传
- `methodBlocklist` / `methodAllowlist`（可选）— `scene.call_component_method` 权限控制，详见桥 README

### 2. 启动 MCP Server

**推荐：在独立 cmd 窗口运行（不占用 AI 工具的终端）**

```powershell
# 在 PowerShell 或 cmd 中执行：
Start-Process -FilePath "cmd.exe" -ArgumentList "/K", "cd /d path\to\SimpleMcpServer && start.bat"
```

或者在文件管理器双击 `start.bat` 也会弹出 cmd 窗口。

```bash
# 编译 + 启动（直接在当前终端）
start.bat

# 跳过编译（代码未改时）
start-quick.bat
```

连接成功输出：

```
[Server] Bridge connected
[Server] Registered N tool(s) from bridge [ID: xxxx]
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

#### 支持的传输端点

| 传输 | 端点 | 说明 |
|------|------|------|
| **Streamable HTTP（推荐）** | `GET/POST /mcp-stream` | MCP 2025-11 规范推荐传输（GET=SSE 事件流 + POST=JSON-RPC），新客户端优先用这个 |
| SSE（legacy） | `GET /sse` + `POST /mcp?sessionId=...` | 旧版 MCP SSE 传输，为兼容旧客户端保留 |
| 直接 JSON-RPC | `POST /rpc` | 非 MCP 会话协议，供脚本/测试直接用（如 autobot） |

AI 代理若走网络连接本 Server（非 stdio），`url` 填 `http://<host>:45678/mcp-stream`（推荐）或 `/sse`。

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

## 外部 MCP 适配器（plan C：接入社区 MCP server）

除了直连自家桥（WebSocket wire protocol），Server 还能作为 **MCP 客户端** 对接外部标准 MCP server，把它们的工具以 `<toolsPrefix>.<工具名>` 暴露给 AI。社区生态（BlenderMCP、UE MCP 等）无需重写桥即可接入，且与桥工具**并存**（`/rpc` 与 `/mcp` 均可用）。

配置（`config.json` 的 `mcpServers` 段，改后重启生效）：

```json
"mcpServers": [
  { "name": "blender", "command": "uvx", "args": ["blender-mcp@1.9.1"], "toolsPrefix": "blender" }
]
```

`mcpServers` 条目字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | 适配器名（进程名/日志/去重 key） |
| `command` | ✅ | 启动外部 MCP server 的命令（如 `uvx` 的绝对路径；PATH 里可直接写 `uvx`） |
| `args` | 可选 | 命令行参数（推荐 pin 版本，如 `["blender-mcp@1.9.1"]`） |
| `env` | 可选 | 注入给子进程的额外环境变量（如 `{"BLENDER_PORT":"9877"}` 指向第二个 Blender 实例） |
| `toolsPrefix` | 可选 | 工具前缀，默认 = `name`（工具以 `<前缀>.<工具名>` 暴露） |
| `enabled` | 可选 | `false` = 不启动该适配器（免删条目临时下线） |

- `command` / `args` — 以 stdio 启动外部 MCP server（推荐 pin 具体版本，防上游漂移）
- 生命周期：服务器启动时 spawn 并 `tools/list` 拉取工具表；子进程退出后按 **10s→30s→60s→120s 指数退避自动重连**（外部应用如 Blender 重启后无需重启本 Server）
- 工具名冲突时 adapter 优先（先于桥工具合并）
- **危险工具门**：名字以 `.execute_*` 结尾的任意代码执行类工具（如 `blender.execute_blender_code`）与内置 `editor.eval` 同策略——`evalEnabled=false` 时**列表隐藏 + 调用拒绝**
- MCP `image` 块返回（如视口截图）自动落盘到 `mcp-media/` 并返回路径，不塞进文本

### 接入步骤（以 Blender 为例）

> 适配层对接的是社区 **BlenderMCP**（ahujasid/blender-mcp，v1.9.1 实测）。对外部用户来说：AI 客户端接本 Server（MCP），Server 接 Blender（经 blender-mcp），全程只需两步安装 + 配一行配置。

**① Blender 侧——安装 MCP addon（一次性，需在本机装过 `uvx`/`uv`）**

```bash
uvx blender-mcp install-addon    # 写入 %APPDATA%\Blender Foundation\Blender\<版本>\scripts\addons\
```

**② Server 侧——`config.json` 配 `mcpServers`（本仓库已内置 `config.json.template` 示例）**

```json
"mcpServers": [
  { "name": "blender", "command": "uvx", "args": ["blender-mcp@1.9.1"], "toolsPrefix": "blender" }
]
```

> 版本一致性：addon 与 `blender-mcp` 的版本建议一致（协议握手 `ADDON_PROTOCOL_VERSION` 校验，不一致连接会失败）。

**③ 启动 Blender 窗口实例**：addon 的 `Auto-Start Server` 选项默认开启——**在任何 Blender 窗口的偏好设置里启用一次 addon**（保存偏好）后，该实例每次启动都会自动启用 addon 并自动起 socket（默认端口 9876）。如需全自动（首次启用也不用手点），可在 Blender 用户目录 `scripts/startup/` 放一个 `addon_utils.enable` 的小脚本（团队环境做法见 AGENTS.md 相关记录）。本仓库提供了多实例启动脚本：

```powershell
pwsh scripts\start-blender-instance.ps1 -Instance 1
```

**④ 验证**

```bash
# /rpc tools/list 应见 blender.* 工具
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"blender.get_scene_info","arguments":{"user_prompt":""}}}
```

链路（实测通过，2026-09）：`AI → Server(adapter) → uvx blender-mcp(stdio) → TCP 9876 → Blender addon → bpy`。实测全流程：建低多边形树（建模 → smart_project UV → 平滑 + Principled 材质 → 视口截图落盘 `mcp-media/`）可用。

### 多 Blender 实例（同时开多个窗口，各自独立控制）

原理：**每个实例 = 独立 socket 端口 + 独立的 blender-mcp 进程**（适配层本来就按 mcpServers 条目逐条 spawn）+ 独立工具前缀。端口分配：实例 N → `9875+N`（实例1=9876，实例2=9877…）。

1. **起实例**（脚本注入 `BLENDER_MCP_PORT` 环境变量；Blender 的 startup 脚本 `blender_mcp_auto.py` 据此用对应端口起 addon socket）：

```powershell
pwsh scripts\start-blender-instance.ps1 -Instance 2        # 第 2 个窗口 → 端口 9877
pwsh scripts\start-blender-instance.ps1 -Instance 2 -BlendFile D:\proj\a.blend
```

2. **config.json 每条实例加一条 mcpServers**（`env.BLENDER_PORT` 与实例端口对应）：

```json
"mcpServers": [
  { "name": "blender",  "command": "<uvx>", "args": ["blender-mcp@1.9.1"], "toolsPrefix": "blender" },
  { "name": "blender2", "command": "<uvx>", "args": ["blender-mcp@1.9.1"],
    "env": { "BLENDER_PORT": "9877" }, "toolsPrefix": "blender2" }
]
```

3. 重启 Server → `tools/list` 同时出现 `blender.*` 与 `blender2.*`，调用完全隔离（各自查/改的是对应窗口的场景）。

> 补充：同一实例内切换 .blend **工程**不需要任何配置——socket 是进程级的，agent 看到的就是该窗口当前打开的工程。

### 安全须知（Blender 接入必读）

1. **`blender.execute_blender_code` = 任意代码执行**：可在 Blender 内运行任何 Python（含 `os`/文件/网络）。它受 `evalEnabled` 门控（`config.json`）：置 `false` 后该工具从列表消失且调用被拒。**仅在可信环境开启**。
2. **addon socket 仅监听本机回环**：`BlenderMCPServer` 默认 `bind localhost:9876`，不暴露局域网——**不要**改 host 为 `0.0.0.0` 或做端口转发，否则局域网内的 MCP 客户端可直连你的 Blender。
3. **遥测默认开启**：BlenderMCP 的 `Allow Telemetry` 偏好**默认勾选**，收集 prompt/代码/截图/轨迹数据。关闭：Blender 偏好面板「MCP for Blender」取消勾选，或调用 `blender.disable_telemetry` 工具。
4. **供应链**：`blender-mcp` 建议 pin 版本（示例已 pin `@1.9.1`），addon 同样按该版本安装，避免上游意外更新破坏行为。
5. **权限边界**：AI 对 Blender 的操作 = Blender 进程所属用户的权限（可读写本机文件、调网络）。等同于把"本机 Python 执行权"交给 AI。
6. **退出接入**：删掉/注释 `mcpServers` 块，或在条目内加 `"enabled": false`，重启 Server 即断开（不卸载 Blender 侧任何东西）。
7. **已知坑**：Blender 中文界面下默认对象名是本地化的（如 `primitive_cube_add` 生成 "立方体" 而非 "Cube.001"），脚本建议显式 `o.name=...`；经 PowerShell 传中文参数需显式 UTF-8 编码。

### 高层模板工具（本仓库预置的 `blender.*` 快捷工具）

除透传的 blender-mcp 原生工具外，Server 内置一组**高层 Blender 模板工具**（建模/骨骼/动画/导出，无需 AI 写 bpy 脚本）：`blender.rig.humanoid`、`blender.rig.auto_weights`、`blender.anim.loop`、`blender.anim.quadruped`、`blender.mesh.primitive`、`blender.mesh.boolean`、`blender.body.build`（参数化四足/人形体块）、`blender.scene.export`。

> 完整用法、参数表与典型工作流（如"一句话生成会走的四足动物"）见 **[docs/blender-mcp-template-tools.md](docs/blender-mcp-template-tools.md)**。所有模板工具均受 `evalEnabled` 门控，并接受通用参数 `adapter` 指定目标 Blender 实例。

## 可用工具

工具由 Unity Bridge 通过 `register_tools` 动态注册，数量随桥接平台/条件编译变化（当前 Editor 桥实测 127 个桥工具 + 服务端合成 2 个 = 129 个）。下表按类别简述常用工具；完整清单见 [SimpleMCPBridge](https://github.com/redcool/SimpleMCPBridge_Unity) 仓库 README。

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
| `scene.load_scene` | 加载场景（按 Assets 路径，支持 `.unity` 后缀省略）（仅 Editor） |
| `scene.save_prefab` | 将 GameObject 保存为预制体（仅 Editor） |
| `scene.call_component_method` | 调用组件公开方法，带黑名单/白名单权限控制 |

### 资源工具（AssetHandler，仅 Editor）

| 工具 | 说明 |
|------|------|
| `asset.find_assets` | 按名称和/或类型搜索项目 Assets。参数：`nameContains`（可选）、`typeFilter`（可选，如 `"Prefab"`、`"Material"`）。返回 `{path, name, type, guid}` 列表 |
| `asset.find_references` | 查找引用了指定资源的所有资源（反向依赖）。参数：`assetPath`（必填）。扫描文件内容中的 GUID，返回引用者列表。可靠但较慢 |
| `asset.create` | 创建资源（材质/文件夹等）（仅 Editor） |
| `asset.delete` | 删除资源（带引用预检，force 可跳过）（仅 Editor） |
| `asset.rename` | 重命名资源（仅 Editor） |
| `asset.move` | 移动资源到新路径（仅 Editor） |

### 录制工具（RecordingHandler）

| 工具 | 说明 |
|------|------|
| `recording.start` | 开始录制 Game 视图画面。仅 Play Mode 可用。可选参数：width/height/fps/videoBitRate/enableAudio/keyframeInterval |
| `recording.stop` | 停止录制并导出 MP4（异步）。返回后调用 `recording.status` 轮询完成状态 |
| `recording.status` | 查询录制/导出状态 — 返回 isRecording/elapsedSeconds/state/exported filePath |

保存位置：
- **PC**: 项目根目录 `VideoRecord/`（Assets 同级）
- **Android/iOS**: app 临时目录 `{temporaryCachePath}/VideoRecord/`

### 编辑器工具

| 工具 | 说明 |
|------|------|
| `editor.request_compile` | 触发 Unity 脚本重新编译（外部修改 C# 后用）（仅 Editor） |
| `editor.open_window` | 按菜单路径打开 Unity Editor 窗口，如 `"Window/General/Console"`（仅 Editor） |

### PlayerPrefs 工具（PlayerPrefsHandler）

| 工具 | 说明 |
|------|------|
| `playerprefs.get_all` | 读取全部 PlayerPrefs（按 key 过滤可选） |
| `playerprefs.get` | 读取单个 key |
| `playerprefs.set` | 设置 key（自动类型推断） |
| `playerprefs.delete` | 删除 key（支持通配符） |

### UI Toolkit 工具（UIToolkitHandler）

| 工具 | 说明 |
|------|------|
| `uitk.create_element` | 在指定面板创建视觉元素 |
| `uitk.remove_element` | 移除视觉元素 |

## 配置

编辑 `config.json`（不存在时首次启动自动从 `config.json.template` 复制生成，见「首次运行」）。完整字段：

```json
{
    "ip": "0.0.0.0",
    "port": 45678,
    "encryptionKey": "",
    "encryption": false,
    "evalEnabled": true,
    "allowedIps": ["127.0.0.1", "::1"],
    "llm": { "enabled": true, "provider": "agnes", "baseUrl": "https://apihub.agnes-ai.com/v1", "apiKey": "YOUR_API_KEY_HERE", "model": "agnes-2.0-flash", "temperature": 0.7, "maxTokens": 1024 },
    "webSearch": {
        "order": ["serper", "google", "bing", "ddg-html", "ddg-lite"],
        "region": "zh-CN",
        "serper": { "apiKey": "" },
        "google": { "apiKey": "", "cx": "" },
        "providerTimeoutMs": 15000,
        "cooldownMs": 60000
    }
}
```

- `ip`/`port`：监听地址与端口。本地 `127.0.0.1`，云端 `0.0.0.0`
- `encryption`/`encryptionKey`：可选 AES-256-CBC 载荷加密（替代 TLS/wss），Server 与 Bridge 配置需一致；空密钥 = 透传
- `evalEnabled`：`editor.eval` 工具开关（默认 `true`，以用户方便为先 —— 开发调试/快速原型/补救缺口工具时即时可用）。`false` 时 `tools/list` 不暴露 `editor.eval` 给 agent。**风险**：eval 执行任意 C# = 完全机器控制，任何能调 `/rpc` 的 AI 可执行任意代码（读写文件、删资产、网络访问）；不可信环境（共享机器/公网暴露）务必关闭或扩 `allowedIps` 白名单。Editor 侧另有 `EditorPrefs SimpleMCPBridge_EvalEnabled` 二次 gate，见桥 README「Editor Eval 开关与安全说明」
- `allowedIps`：**IP 白名单（本版本新增）**——只放行白名单内的客户端访问 HTTP `/rpc`、`/sse`、`/mcp` 端点、WebSocket `/` 桥接通道以及 `/ab` 资产端点，其余连接返回 403（WS）或 404（HTTP）；默认 `["127.0.0.1","::1"]` 仅本机。**配置缺失时自动从 `config.json.template` 复制生成 config.json（首次启动自动创建，见「首次运行」）**；**字段缺失/为空数组/非数组时回退到默认 `["127.0.0.1","::1"]`（仅本机）**
- `llm`：LLM 配置（apiKey 用环境变量 `LLM_API_KEY` 覆盖更安全；config.json 已被 .gitignore 排除，勿提交真实 key）
- `webSearch`：`web.search` 工具的多引擎配置（改动后重启生效）
  - `order`：引擎优先级（默认 `serper → google → bing → ddg-html → ddg-lite`），按序尝试，失败自动降级；未配置凭据的引擎自动跳过
  - `region`：中文查询的语言区域（默认 `zh-CN`），Serper/Google/必应/DDG 会带上对应 `gl/hl`、`mkt`、`kl` 参数，显著改善中文搜索质量
  - `serper`：**可选（推荐）**——填 `apiKey`（[Serper.dev](https://serper.dev/)，Google 搜索结果 API，免费约 2500 次/月、免信用卡、需 Google 可达的网络——公司网络可用）即可启用。服务器启动时会探测 `google.serper.dev` 可达性——**大陆网络（Google 不可达）自动回退 Bing/DDG，无需改配置**；成功率/延迟最佳，中文质量 = Google
  - `google`：**可选**——Programmable Search JSON API（**对新用户已关闭**，仅老 key 可在 2027-01-01 前使用），留空自动跳过
  - `providerTimeoutMs`：单引擎请求超时（默认 15s；Serper/Google 探测用其中最多 5s）
  - `cooldownMs`：某引擎连续失败 ≥2 次后的冷却时间（默认 60s；防止被墙引擎每次拖慢所有搜索）

## 开发

```bash
npm run dev           # tsx 监听模式
node tests/test-e2e.cjs  # E2E 测试

# 目录结构
src/
├── index.ts           # 入口（启动 server）
├── server.ts          # WS Server + MCP handlers（核心）
├── bridgeState.ts     # bridge 连接状态/路由（last-registration-wins、failover）
├── ab.ts              # AssetBundle 上传/部署端点
├── crypto.ts          # AES-256-CBC 载荷加密（#ENC# 前缀）
├── config.ts          # config.json 加载（缺失时从 template 生成）
├── llm.ts             # LLM 代理（ai_request/ai_response）
├── logger.ts          # 日志（stderr + server.log，脱敏）
├── tools.ts           # 服务端合成工具（bridge.list / bridge.call）
└── types.ts           # 类型定义
tests/
├── test-e2e.cjs           # E2E 测试（initialize + tools/list + get_hierarchy）
├── test-playmode-cycle.cjs # Play Mode 循环测试（进出播放验证 bridge 自动重连）
└── auto-test-android.ps1  # Android 全流程自动化测试
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

**HTTP 调用返回 403**
→ 请求源 IP 不在 `allowedIps` 白名单。修改 config.json 的 `allowedIps` 加来源 IP 后重启服务端。

## 相关仓库

| 仓库 | 说明 |
|------|------|
| [SimpleMcpServer](https://github.com/redcool/SimpleMCPServer) | 本仓库 — MCP Server，Node.js 端 |
| [SimpleMCPBridge](https://github.com/redcool/SimpleMCPBridge_Unity) | Unity 桥接包，clone 到 Unity 项目的 `Assets/` 下 |

## 技术说明

- MCP SDK v1.x 低阶 API（`setRequestHandler`），不用 `registerTool()`（该 API 在 `connect()` 后抛出异常）
- WebSocket 通信（`ws` 库），IP/Port 来自 `config.json`
- 工具通过 `register_tools` 消息从 Bridge 动态注册到 Server，Bridge 重连后自动重新注册
- Unity Bridge 活动传输为 .NET `ClientWebSocket`（`NetWebSocketClient` 封装，`BridgeClient.ConnectToServer()` 创建）；旧版纯 TCP RFC 6455 实现（`WebSocketClient`）已标记 `[Obsolete]` 仅作参考
- Server 同时暴露 HTTP `/rpc` 端点用于程序化调用（E2E 测试使用）
- `/health` 端点返回 bridge 连接状态、工具列表、播放模式状态
- HTTP `/rpc`、`/sse`、`/mcp` 端点受 `allowedIps` 白名单 gate（403）；WebSocket 桥接通道（1008 Forbidden）与 `/ab` 端点同样受白名单控制
- 消息负载上限 4MB（maxPayload）
- 服务端每 ~30s ping、超时未 pong 判定失活并 `terminate()` 断连（isAlive 心跳）
- 日志脱敏：工具名 + 参数长度（不打印明文 payload），错误路径保留详情
- config.json 不存在时首次启动自动从 template 复制生成；改完配置重启生效
- 进程级安全网：`uncaughtException` / `unhandledRejection` handler 记日志后继续运行（不崩进程），防单个坏工具响应或未捕获 rejection 带走整个 relay（丢连接 + retryQueue + 在途调用）
