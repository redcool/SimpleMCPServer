# Unreal 5 Adapter Source

唯一源代码目录：SimpleMcpServer/unreal5。UE 工程只引用或同步此目录。

## Layers
- `Plugins/MCPUnrealBridge`: native C++ operations and inspection.
- `Python`: UE Python fallback operations.
- `Scripts`: safe sync/build/verify helpers.

Do not sync `Binaries`, `Intermediate`, `Saved`, or unrelated Content assets.
