# 后端接入

## Unity / Godot Bridge

Server 通过同一端口的 WebSocket 接收 Bridge 注册工具并转发调用。Bridge 是独立工程，不在本仓库内。连接前确认 Server 的 `ip`/`port` 与 Bridge 配置一致，并用 `/health` 检查连接。

- Unity companion：[SimpleMCPBridge_Unity](https://github.com/redcool/SimpleMCPBridge_Unity)
- Godot Bridge：见工作区维护的 `SimpleMcpBridge_Godot` 工程
- 通过 `register_tools` 动态注册；工具数量和名称由 Bridge 版本、平台和条件编译决定，不要在本仓库文档中写死数量。
- 场景对象寻址等 Bridge 行为以对应 Bridge 的 README 和 `tools/list` schema 为准。

本仓库没有重新验证 Unity/Godot 编辑器端到端链路；历史验证记录不能替代当前实测。

## BlenderMCP

源码位于 `src/blender/`，由 `blenderTools.ts` 统一注册基础、高级、manifest 和 walk 工具；`blenderAdapter.ts` 负责多实例选择和结果归一化。

Server 作为 MCP Client 启动 `mcpServers` 中的 stdio 子进程；适配器工具以 `<toolsPrefix>.<tool>` 暴露。Blender Add-on、Blender 进程和 adapter 是三层独立状态，均需检查。

最低配置示例（版本仅为工作区历史实测值，使用前请复核上游）：

```json
"mcpServers": [
  { "name": "blender", "command": "uvx", "args": ["blender-mcp@1.9.1"], "toolsPrefix": "blender" }
]
```

接入步骤：

1. 按 BlenderMCP 版本说明安装并启用 Add-on。
2. 启动 Blender 的 Add-on socket（默认本机端口通常为 9876；实际以 Add-on 配置为准）。
3. 配置 `mcpServers`，重启 Server。
4. `GET /health` 查看 adapter，再用 `tools/list` 确认工具，最后做一个无破坏查询。

多实例时，每个 Blender 窗口、socket 端口、adapter 条目和 `toolsPrefix` 必须一一对应。仓库脚本 `scripts/start-blender-instance.ps1` 是本机辅助脚本，默认路径和版本是环境特定值，使用 `-BlenderExe` 覆盖。

### Blender 工具路由限制

基础模板、高级、导出 manifest/compare 和 walk setup 现在都暴露 `adapter` 参数，并经共享路由选择指定前缀；省略时按配置顺序选择第一个健康适配器。指定的前缀没有在线 `execute_blender_code` 工具时会明确失败，不会静默切换到其他实例。

`evalEnabled=false` 时内置 Blender 工具和外部任意代码执行工具都会被隐藏并拒绝。Blender Python 执行权限等同于 Blender 进程用户权限。

## 不要把历史实测当保证

Blender Action/manifest 脚本已在本机 Blender 5.2.0 `--background --factory-startup` 隔离场景验证；这不等于当前 Add-on socket、真实用户资产、导出轴向或 Unity/Godot/Unreal 导入回归已验证。

## Unreal MCP（规划）

四阶段骨架已完成：`unrealAdapter.ts` 负责实例选择和结果封装；`unrealTools.ts` 提供 health/capabilities；`unrealAssetTools.ts` 提供 manifest/import-status/validation/job；`unrealCapabilityTools.ts` 提供 Level/Actor/Material/Animation；`unrealPipelineTools.ts` 提供 validate/compare/snapshot/smoke-test。写操作要求 `confirm=true` 或 `dryRun=true`，所有调用沿用 `evalEnabled`、`allowedTools`、显式 adapter 选择和不自动重试语义。当前仅完成源码和静态测试，真实 Unreal MCP 端到端验证仍待接入实际 adapter。