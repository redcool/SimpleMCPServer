# 文档索引

## 当前指南

- [项目入口](../README.md)：安装、启动、MCP 客户端连接。
- [架构与目录](architecture.md)：Server、Bridge、adapter 和工具层边界。
- [配置与安全](configuration.md)：配置字段、访问控制、危险工具与资源限制。
- [后端接入](integrations.md)：Unity/Godot Bridge、BlenderMCP、Unreal MCP 与多实例。
- [开发与验证](development.md)：构建、测试、E2E 前置条件与已知限制。
- [Blender 模板工具](blender-mcp-template-tools.md)：工具参数和工作流；状态标记以源码和实际测试为准。
- [Unreal 破碎流水线](unreal-fracture-pipeline.md)：UE 5.8.2 真破碎导出与跨引擎静态物理闭环实测记录。
- [项目与 Bridge 安装指南](projects-bridge-guide.md)：`projects.json` 模板用法与各引擎 Bridge 安装手册（Agent 驱动，服务器不读取）。
- [搜索指南](SimpleMCPServer搜索指南.md)：`web.search` 使用原则。
- [PowerShell JSON 坑](../MEMO-PowerShell-Json-Depth.md)：嵌套数组参数。

## 项目记忆

- [Agent 规则](../AGENTS.md)：工作区约定和变更更新协议。
- [会话记忆](../session_memory.md)：历史决策与坑，不是当前状态；不得写入密钥。
- [Agent 工作纪律](Agent工作纪律.md)：包含版本号规则（x.y.z.w）与 .trash/tmp 目录约定。

## 历史

- [整理前 README](archive/README-before-reorganization.md)：仅供追溯，不作为操作指南。

文档核对基线：2026-09-20。没有经过对应外部环境实测的内容，统一标为“未验证”或“历史记录”。
