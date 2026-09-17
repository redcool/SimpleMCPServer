# Unreal 破碎跨引擎流水线

## 当前结论

UE 5.8.2 的 Chaos Fracture 编辑器接口和 Geometry Collection 内部数据并没有稳定、统一的 Python 破碎 API。首版不把 `unreal.fracture.create` 伪装成已经可用的通用函数。

推荐最小闭环：

1. 在 Unreal Editor 的 Fracture Mode 手工创建并保存 Geometry Collection；
2. 使用 Chaos Caching / Sequencer 录制短缓存；
3. 由 Python 在固定帧率下采样碎片 Transform；
4. 导出 `pieces + transform_animation.json + manifest.json + validation.json`；
5. Unity 选择使用 Transform 动画，或忽略动画并用 Rigidbody 自行驱动。

## 方案 C 导出模式

`static_physics`：只导出每个碎片的静态 Mesh，`animation=null`，并设置 `physicsRecommended=true`。

`transform_animation`：导出碎片 Mesh 与每碎片 TRS 轨道。

`both`：同时输出静态物理资产和 Transform 动画。

Transform track 必须包含稳定的 `chunkId`、`times`、`translation`、`rotationQuat`、`scale`，数组长度一致。

## 其他格式

- VAT：需要专用烘焙/编码后端，不能假定 UE Python 内置 Geometry Collection→VAT。
- Alembic：UE Python 主要偏导入，Geometry Collection 导出接口需目标版本实测或 C++/commandlet。
- Skeletal FBX：适合少量碎片，需确认骨骼绑定和导出模块。

## 安全与验证

所有写操作要求 `confirm=true` 或 `dryRun=true`。导出 Manifest 使用 `schemaVersion: fracture-1.0`，记录引擎版本、坐标系、单位、稳定 chunk ID、文件和校验结果。不得把同步 `execute_python` 伪装成远端异步 Job；真正的 Job 需要本地执行记录或 UE 侧缓存/任务状态。

## 当前实现状态

SimpleMcpServer 已能通过 Streamable HTTP 连接 UE 5.8.2 的 Unreal MCP Toolkit，并已加入方案 C 工具契约注册。实际 Geometry Collection 采样、导出和 Unity 端到端验证仍待在目标项目中完成。
## UE 5.8.2 实机探测

已在 `H:/ai_works/TestUnrealMcpPrj` 通过 Unreal MCP Toolkit 实测：`GeometryCollection`、`GeometryCollectionComponent`、`GeometryCollectionFactory`、`ChaosCache`、`ChaosCacheManager`、`GeometryCollectionCacheFactory`、`MovieSceneChaosCacheTrackRecorder` 和 `TakeRecorderChaosCacheSource` 可被 Python 反射发现。已创建测试资产 `/Game/MCPTest/Fracture/GC_TestCube` 和测试关卡 `/Game/MCPTest/Levels/MCP_TestLevel`，并生成带 warning 状态的初始 Manifest。

当前仍需在 Editor Fracture Mode/Chaos Caching 中完成真实破碎和短缓存录制；本轮没有声称已生成碎片 chunk 或 Transform animation。

## Geometry Collection Source API 实测补充

UE 5.8.2 暴露了 `GeometryCollectionSource` 结构，其 `source_geometry_object` 需要 `SoftObjectPath`，不是直接 StaticMesh 对象。已将 `/Engine/BasicShapes/Cube.Cube` 写入测试资产 `/Game/MCPTest/Fracture/GC_TestCube` 的 `geometry_source` 并保存成功。

但仅设置 `geometry_source` 不会触发 Geometry Collection 数据构建：绑定到 `GeometryCollectionComponent` 后，`get_current_transforms()` 仍返回空数组。因此该属性是源描述，不是稳定的 Python 构建/破碎入口；仍需 Geometry Collection Editor/Dataflow/Fracture Mode 完成实际构建。

## Dataflow 编辑器 API 探测

UE 5.8.2 暴露 `DataflowEditorBlueprintLibrary.add_dataflow_node`、`connect_dataflow_nodes`、`set_dataflow_node_property`、`DataflowBlueprintLibrary.evaluate_dataflow` 和 `regenerate_asset_from_dataflow`。但当前测试 `GC_TestCube` 的 `dataflow_asset` 为 `None`、`dataflow_instance` 为空，且这些函数的 Python 参数签名没有在运行时暴露。未在没有签名和节点类型确认的情况下盲目构造 Dataflow 图，避免生成不可验证或损坏的测试资产。