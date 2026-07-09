# PowerShell `ConvertTo-Json` 截断嵌套数组

## 问题

在 PowerShell 中测试 MCP Bridge 时，`set_transform` 传入 `"position":[2,3,4]`，
但桥接收到的却是 `"position":"2 3 4"`（字符串），导致位置设置无效。

## 根因

PowerShell 5.1 的 `ConvertTo-Json` **默认 Depth=2**。嵌套超过 2 层的数组会被 `.ToString()` 自动转为空格分隔的字符串。

```powershell
# ❌ 错误写法 — Depth=2，嵌套数组被截断
$body = '{"params":{"arguments":{"position":[2,3,4]}}}' | ConvertFrom-Json | ConvertTo-Json -Compress
# → 实际发出: "position":"2 3 4"
```

## 修复

### 方法 A：传原始 JSON 字符串（推荐）

绕过 `ConvertFrom-Json` / `ConvertTo-Json` 往返，直接传字符串：

```powershell
$json = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"scene.set_transform","arguments":{"instanceId":8358,"position":[2,3,4]}}}'
Invoke-RestMethod -Uri "http://127.0.0.1:45678/rpc" -Method Post -Body $json -ContentType "application/json"
```

### 方法 B：指定 Depth

如果必须用 `ConvertTo-Json`，加 `-Depth 10`：

```powershell
$body | ConvertTo-Json -Compress -Depth 10
```

## 影响范围

所有包含嵌套数组参数的 MCP 工具调用：
- `scene.set_transform` — `position`, `rotation`, `scale`
- `scene.create_object` — `position`, `rotation`, `scale`
- `scene.set_component_property` — `value`（当值为 Vector3/Color 等数组类型时）
- 其他带数组参数的任意 RPC 调用

## 检测方法

在 Android 上跑 `adb logcat -s Unity`，搜 `[ParseJsonObject]` 查看 `valueStr`。
如果数组变成了空格分隔的字符串（如 `"2 3 4"`），就是此问题。
