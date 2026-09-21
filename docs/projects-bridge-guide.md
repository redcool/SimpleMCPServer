# projects.json 与 Bridge 安装指南（Agent 手册）

> 本文档是给 **Agent** 看的操作手册：如何读取 `projects.json`、判断是否需要安装
> Bridge，以及按引擎类型执行安装。SimpleMcpServer **不读取、不解析、不执行** 本文件
> 与 `projects.json` —— 一切由 Agent 按用户指令驱动。

## 1. 定位与规则

- `projects.json`（真实文件）仅描述：**本机有哪些引擎、哪些工程、控制前是否需要装 Bridge**。
- **不是服务器必需配置**：没有它，服务器照常运行；用户直接口头/对话告诉 Agent 工程信息即可。
- 真实文件含本机路径，**已 gitignore**；仓库内只有模板 `projects.json.template`（占位符）。
- Agent 只按用户明确指令使用它（例：“读 projects.json，帮我安装对应的 bridge”），
  不主动把它当默认前提。

## 2. Schema

```jsonc
{
  "engines": [
    {
      "name": "unity2022",            // 引擎唯一名（项目内引用）
      "type": "unity",                // unity | godot | unreal | blender
      "exe": "D:/.../Unity.exe"       // 引擎可执行文件绝对路径
    }
  ],
  "projects": [
    {
      "name": "TestAIMcpPrj",         // 工程唯一名
      "engine": "unity2022",          // 引用 engines[].name
      "dir": "H:/.../TestAIMcpPrj",   // 工程根目录（绝对路径）
      "isInstallBridge": true,        // true=控制前确保 Bridge 已安装
      "uproject": "X.uproject",       // [仅 unreal] .uproject 文件名
      "mcpPort": 8000                 // [仅 unreal] Unreal MCP 端口
    }
  ]
}
```

判断条件：**存在 `projects.json`，且某条 `projects[].isInstallBridge === true`**，
则该工程的 Bridge 需要被确保在位；否则不保证、不处理。

## 3. 各引擎的 Bridge 形态与安装

### unity —— 类型 `unity`

- **Bridge 是什么**：`SimpleMCPBridge`（UPM 包结构：package.json + Runtime/ + Editor/ + asmdef）。
  最常见的接入方式是工程 `Packages/manifest.json` 里加本地包引用：
  ```json
  "com.simplemcpbridge": "file:../../SimpleMCPBridge"
  ```
- **检查是否已装**：读工程 `Packages/manifest.json`，看是否有指向桥仓库的引用；
  或工程内已存在桥代码/asmdef。
- **安装（缺桥时）**：
  1. 确认桥仓库在磁盘可达（默认预期 `H:/ai_works/SimpleMCPBridge`，可在对话中向用户确认）；
  2. 编辑工程 `Packages/manifest.json` 的 `dependencies`，加
     `"com.simplemcpbridge": "file:<桥仓库绝对路径>"`（路径反斜杠转成 `/`）；
  3. 告知用户：用 Unity 打开工程后桥会编译并自动重连服务器（3s 间隔），
     服务器端日志出现 `Registered N tool(s) from bridge` 即成功。
- **注意**：不要覆盖已有同名 package 引用；改动 manifest 前先备份。

### godot —— 类型 `godot`

- **Bridge 是什么**：`SimpleMCPBridge_Godot`，是 `addons/simple_mcp_bridge/` 插件目录
  （MCPBridge.gd + ToolRegistry.gd + CryptoHelper.gd + Handlers/）+ `bridge-config.json.temp`。
- **检查是否已装**：
  - 工程 `addons/simple_mcp_bridge/MCPBridge.gd` 存在？
  - 工程 `project.godot` 的 `[autoload]` 段含 `MCPBridge="*res://addons/simple_mcp_bridge/MCPBridge.gd"`？
- **安装（缺桥时）**：
  1. 拷贝 `SimpleMCPBridge_Godot/` 全部内容到工程 `addons/simple_mcp_bridge/`（不含 .git/examples 可选）；
  2. 编辑工程 `project.godot`：在 `[autoload]` 段**追加**一行
     `MCPBridge="*res://addons/simple_mcp_bridge/MCPBridge.gd"`；
  3. 若需自定义连接参数（serverIp/端口/encryptionKey/projectName），
     从 `bridge-config.json.temp` 复制为 `bridge-config.json` 再改；
  4. **改 project.godot 前必须备份**，且先检查该 autoload 键是否已存在（避免重复）。
- 桥载入后自动连接并重连服务器。

### unreal —— 类型 `unreal`

- **Bridge 是什么**：**没有**机内运行时桥。接入 = 服务器通过 Streamable HTTP 直连
  Unreal MCP Toolkit（配置里 `mcpServers` 的 `unreal` 条目，`url: http://127.0.0.1:<mcpPort>/mcp`），
  工具调用走 `execute_python` 跑 UE Python。
- **检查是否可用**：`<mcpPort>`（默认 8000）TCP 可达 + `unreal.health` 返回正常。
- **C++ 插件例外**：若需要 C++ Editor 能力（如 `MCPFractureBridge` 插件），
  把插件的 `Plugins/` 目录拷入工程 `Plugins/`，然后用对应 UE 版本编译
  （`BuildPlugin` 或启动编辑器触发编译）；这属于插件安装，不是“桥”。
- **安装动作**：多数情况无需向工程写文件；只需保证 UE 编辑器已启动且 MCP 端口在听。

### blender —— 类型 `blender`

- **Bridge 是什么**：**没有**。Blender 走 `blender-mcp`（uvx 子进程）+ 模板代码
  （`src/blender/` 内置），任何工程都不需要向 Blender 安装/拷贝文件。
- **检查是否可用**：服务器 `/health` 里 blender adapter 在线；
  或 `blender.<prefix>.execute_blender_code` 可调用。
- **安装动作**：无。

## 4. 通用安全规则

1. **改任何工程文件前先备份**（manifest.json / project.godot 整份复制一份带时间戳的副本）；
2. **先检查、后写入、再确认**：先 `check` 缺什么 → 向用户说明将做什么 → 得到同意再写；
3. 不覆盖已有配置（package 名、autoload 键、端口）；冲突时停下询问用户；
4. 装完只报告“已装/待用户重启引擎”，不假装引擎已连接——连接由引擎侧完成。

## 5. Agent 工作流示例

```
用户：读取 projects.json，帮我安装对应的 bridge。
Agent：
 1. 读 projects.json，过滤 isInstallBridge===true 的条目；
 2. 对每条按上表检查（unity: manifest 引用；godot: addons+autoload；
    unreal: mcp 端口；blender: adapter 在线）；
 3. 已装 → 跳过；未装 → 备份 → 写入/拷贝 → 汇总；
 4. 报告结果 + 提示哪些需要用户重新打开引擎才能生效。
```