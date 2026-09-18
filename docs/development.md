# 开发与验证

## 常用命令

```powershell
npm ci                 # 按 lockfile 安装
npm run build         # tsc，输出 dist/
npm test               # build + node --test tests/*.test.cjs
npm run dev           # tsx 直接运行源码
npm start              # 运行 dist/index.js
```

`start.bat` 会先构建再启动；`start-quick.bat` 跳过构建，只适用于 dist 已更新的情况。

## 测试分层

| 测试 | 是否包含外部软件 | 说明 |
|---|---:|---|
| `tests/regression.test.cjs` | 否 | 配置安全、加密、工具合并、pending 请求等模块回归 |
| `tests/blender_pipeline.test.cjs` | 否 | `src/blender/` Blender 工具源码静态特征检查，不执行 bpy |
| `tests/blender_adapter.test.cjs` | 否 | adapter 路由、schema 和 Action API 兼容脚本静态回归 |
| `tests/blender_adapter_behavior.test.cjs` | 否 | 显式/默认 adapter 选择、参数剥离、MCP/RPC 结果封装行为测试 |
| `tests/blender_action_compat.test.cjs` | 需要 Blender 5.2（缺失时跳过） | factory-startup 隔离场景验证 layered Action、manifest、loop 和保留既有 Action |
| `tests/test-e2e.cjs` | 需要 Server，通常还需 Bridge | HTTP `/rpc` 初始化、工具列表和场景查询 |
| `tests/test-playmode-cycle.cjs` | 需要 Unity Bridge | Play Mode 进出和重连 |
| `tests/auto-test-android.ps1` | 需要 Android/Unity 环境 | 平台测试脚本 |

运行完整 `npm test` 前不需要启动 Server；E2E 脚本需要先启动 Server，调用前确认 `tools/list` 中存在目标工具。没有 Unity/Godot/Blender 实例时，不要把 E2E 失败解释成 TypeScript 构建失败。

## 修改原则

- 先看 `git status`，不覆盖其他 Agent 的未提交修改。
- `config.json`、日志、`mcp-media/`、`ab-cache/` 不应写入提交；不在文档、日志或测试输出中打印密钥。
- 工具新增/改名/参数变化时，同步更新 `AGENTS.md`、相关专题文档和静态/行为测试。
- 新增配置字段时同步 `config.json.template`，并说明默认值、安全影响和重启要求。
- Blender 长 bpy 脚本拆成小步骤；执行前后用 scene/manifest/screenshot 检查。

## 已知限制（当前工作树核对）

1. Blender Action 曲线通过共享兼容 helper 读取旧式 `fcurves` 或 4.x/5.x layered Action channelbags；已在 Blender 5.2.0 `--background --factory-startup` 隔离场景验证 list/info/loop/root motion/manifest 及 loop 生成。
2. 所有内置 `src/blender/` Blender 工具现在通过共享 adapter 路由；指定 `adapter` 时不会静默切换实例。路由静态测试不代表真实 Blender 执行成功。
3. 导出 preset/validateOnly 的语义应以当前源码为准；validateOnly 只返回场景摘要，不代表 Unity/Unreal/Godot 导入成功。
4. `/health` 的 `totalTools` 是 Bridge 路由统计，不是合并后的全部工具数量。
5. adapter 进程在线不代表 Blender Add-on、socket 或当前场景健康。
6. 文档中的版本、端口、资产和外部产品行为带日期，仅代表当时环境。

## 排查顺序

1. `npm run build`。
2. `GET /health`：监听、白名单、认证、Bridge、adapter。
3. `tools/list`：确认工具是否因 `evalEnabled`、`allowedTools`、适配器状态而隐藏。
4. 对目标工具做最小只读调用。
5. 再执行有副作用的操作，并保留结果和失败信息。