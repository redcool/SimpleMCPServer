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

## 简单碎块导出 fallback 实测

已验证 UE 5.8.2 的 `StaticMeshExporterOBJ` 和 `StaticMeshExporterFBX` 可通过 `AssetExportTask` 导出 `/Engine/BasicShapes/Cube.Cube`。测试输出：`source_cube.obj` 与 `source_cube.fbx`，并复制生成 8 个带稳定 ID 的 piece 文件。

由于当前 Geometry Collection 仍为空，这 8 个文件是“可爆炸装配 fallback”：每个 piece 使用同一个 Cube Mesh，通过 Manifest 中的局部 Transform 排列为 2×2×2，并在 Unity 侧添加 `BoxCollider` + `Rigidbody` 后施加 `AddExplosionForce`。这不是具有真实切割面的 Fracture Mesh；Manifest 明确标记 `TRUE_FRACTURE_SURFACES` 为 warning。

## 简单 Cube 爆炸方案结果

已完成可运行的 fallback 包：

- `piece_000.obj` … `piece_007.obj`
- 对应 8 个 FBX 文件
- `fallback_piece_manifest.json`
- Unity 运行时 `ExplodableFracturePieces_v2.cs`
- Unity Editor 构建器 `ExplodableFracturePiecesEditor_v2.cs`

Unity 流程：把 piece 模型导入 `Assets/FractureExport/`，执行菜单 `MCP/Build Fallback Fracture Pieces`，脚本创建 8 个带 Collider/Rigidbody 的对象；调用 `Explode(origin)` 后解除 kinematic 并施加 `AddExplosionForce`。该包是验证跨引擎物理闭环的 fallback，不是 Geometry Collection 真切割结果。

## True fracture attempt 2026-09-17

已确认 Dataflow Python 函数签名：`add_dataflow_node(dataflow, node_type_name, base_name, location)`、`connect_dataflow_nodes(...)`、`set_dataflow_node_property(...)`、`evaluate_dataflow(dataflow, asset_to_update)`。UE 源码进一步确认真实节点名为 `StaticMeshToCollection`、`VoronoiFracture`、`GeometryCollectionTerminal`。

已创建 `/Game/MCPTest/Fracture/DF_TestCube` 和 `/Game/MCPTest/Fracture/GC_RealFracturedCube`，尝试加入 StaticMeshToCollection→GeometryCollectionTerminal 图。节点创建和保存成功，但连接返回 `False`，Dataflow 重新生成返回 `False`，目标资产仍无 geometry source / transform 数据。当前不能声称真实破碎完成；下一步需在 Editor Dataflow/Fracture Mode 中确认节点端口连接规则或手工保存一次有效图。

## Conversion command crash evidence

已确认 Geometry Collection Editor 提供控制台命令 `GeometryCollection.CreateFromSelectedActors` 和 `GeometryCollection.CreateFromSelectedAssets`，其内部会调用 `FGeometryCollectionEngineConversion::AppendStaticMesh` 并执行 `PrepareForSimulation`。尝试通过 Python 创建并选择测试 Cube 后执行 Actor 转换命令时，UE 5.8.2 Editor 触发断言并退出：`Object is not packaged: GeometryCollection GeometryCollectionAsset`。这是 Editor 转换命令在当前 Python/临时对象调用路径下的真实崩溃证据；已重启测试 Editor，未继续重复该危险调用。后续应使用带正确包名的 C++ Editor 工具/插件封装 AppendStaticMesh + PrepareForSimulation，或在 Editor UI 中执行转换，而不是再次从 Python 直接调用该命令。

## C++ fracture bridge progress

为绕过 Python Dataflow 绑定限制，已在测试工程创建 Editor-only 插件 `MCPFractureBridge`，实现控制台命令 `MCP.FractureCube`：加载 `/Engine/BasicShapes/Cube`，使用 `FGeometryCollectionConversion::AppendStaticMesh` 创建带正确包名的 Geometry Collection，调用 `FFractureEngineFracturing::UniformFracture`（8 sites、固定 seed 1337），并保存到 `/Game/MCPTest/Fracture/GC_RealCube_v2`。

插件已通过 UE 5.8.2 Win64 实际编译：`BuildPlugin ... MCPFractureBridgePackage_v7` 返回 `BUILD SUCCESSFUL`。此前 v1-v6 的 SavePackage/console 生命周期/链接问题已修正。尚未在重启后的 Editor 中执行 `MCP.FractureCube`，因此真实 chunk 数据和导出 Mesh 仍未宣称完成。

## Round 3 verification

C++ bridge v8 曾加入 `OnPostEngineInit` 自动执行尝试，UE 进程在无头启动中退出且未产生目标资产；已移除自动 hook，恢复为只注册 `MCP.FractureCube` 的稳定手动命令。v9 已重新通过 UE 5.8.2 Win64 `BuildPlugin`，结果 `BUILD SUCCESSFUL`。当前 `/Game/MCPTest/Fracture/GC_RealCube_v2.uasset` 尚未生成，故真实执行/真实 chunk/真实导出仍未完成。

## Round 3 current evidence

已将 v9 编译出的 DLL 安装到测试工程 `Plugins/MCPFractureBridge/Binaries/Win64`，但 Editor 命令行启动未提供可用 MCP 端口，也没有生成 `GC_RealCube_v2.uasset`；因此未执行或声称成功执行 `MCP.FractureCube`。清理后的手动命令源码已移除自动启动 hook，v10 再次通过 `BuildPlugin`（`BUILD SUCCESSFUL`）。当前可交付的是可编译 bridge + fallback 包，真实 Geometry Collection/真实碎块导出仍需在可交互 Editor 会话中调用命令并读取结果。

## Round 4 MCP startup finding

定位到 UE MCP 无法启动的原因：命令行参数应使用 `-ModelContextProtocolStartServer`，而不是此前的 `-ExecCmds=ModelContextProtocol.StartServer`。使用正确参数后，UE 确实监听了 8000/8001/8002，但 MCP HTTP handshake 在当前无头/nullrhi 启动中超时并产生 CrashReportClient 记录，未能安全执行 fracture 命令。另确认脚本 `execute_console_command` 只能在稳定 MCP 会话中调用控制台命令。

本轮强化了 package null 检查，v11 通过 UE 5.8.2 Win64 BuildPlugin；仍没有 `GC_RealCube_v2.uasset`，所以真实 chunk 与 Mesh 导出尚未宣称完成。

## Round 5 MCP configuration result

确认 `UModelContextProtocolSettings` 配置项为 `ServerPortNumber`、`ServerUrlPath`、`bAutoStartServer`。已创建测试工程配置 `Config/DefaultEditorPerProjectUserSettings.ini`，启用 `/mcp`、8000、AutoStart。无头与普通渲染 Editor 都能监听 8000，但 initialize POST 在当前环境持续超时、无响应并产生 CrashReportClient 记录；即使显式 `-ExecCmds=ModelContextProtocol.StartServer` 也相同。因此本轮仍未执行 `MCP.FractureCube`，目标资产不存在。

## Round 5 real fracture evidence

本轮首次完成可复现的 UE 5.8.2 实机闭环前半段：使用 `UnrealEditor-Cmd.exe -run=PythonScript -Script=...` 执行启动脚本，日志确认 `MCP fracture result=1 saved=1 transforms=9`，并生成 `Content/MCPTest/Fracture/GC_RealCube_v2.uasset`（约 18 MB）。独立 Python 验证生成 `Saved/real_gc_verification.json`：asset 路径正确、`transforms=9`。这证明是真 Geometry Collection，不是重复 Cube fallback。

随后实测 per-piece export 边界：`StaticMeshExporterOBJ` 明确拒绝 GeometryCollection；FBX 任务的 `FbxExportOption` 不能赋给 `AssetExportTask.exporter`，且当前 Python API 没有逐 chunk StaticMesh 提取接口。因此真实碎块 Mesh 导出仍未完成。已生成 truthful manifest `Saved/Exports/RealCube_v2/real_fracture_manifest.json`，明确 `pieces=[]`、`validation.status=partial`，不冒充完整包。

## Round 5 per-piece mesh export completion

进一步复用 UE Fracture Editor 的公开 `PlanarCut::ConvertToMeshDescription`：bridge v12 为每个 rigid transform 创建独立 `UStaticMesh` package。v12 `BuildPlugin` 成功；实际执行后生成 8 个资产：`GC_RealCube_v2_Piece_001` … `_008`。随后通过 `StaticMeshExporterOBJ` 成功导出 8 个 OBJ，`piece_export_result.json` 报告 8/8 pieces、errors=[]，文件大小约 3.9–7.2 MB。

已生成 `real_fracture_manifest_v2.json`：transformCount=9、rigidChunkCount=8、pieces=[1..8]、animation=null、physicsRecommended=true，明确 VAT/Alembic/骨骼和 Transform animation 仍是独立未验证能力。

## Round 6 static physics Unity package

已补齐真实碎块的 Unity 侧导入脚本：`ExplodableRealFracturePieces_v3.cs` 和 `ExplodableRealFracturePiecesEditor_v3.cs`。编辑器菜单 `MCP/Build Real UE Fracture Pieces` 读取 `Assets/FractureExport/RealCube_v2/piece_001.obj` 到 `piece_008.obj`，实例化 8 个真实碎块，为每个碎块添加 convex `MeshCollider`（若没有已有 Collider）和 `Rigidbody`，初始保持 kinematic；调用 `Explode(origin)` 时解除 kinematic 并执行 `AddExplosionForce`。

`real_fracture_manifest_v3.json` 将 Unity import folder、controller、collider、rigidbody 和 explosion contract 写入 Manifest。这样 `static_physics` 的跨引擎最小闭环已具备：真实 Chaos pieces → OBJ → Unity Collider/Rigidbody → explosion。Transform animation、VAT、Alembic、skeletal FBX 仍保留 capability boundary。

## Round 7 validation hardening

增强 `fracture_validate`：除 Manifest 存在、schema、碎块和 static_physics contract 外，现在检查 `pieceExport` 引用文件是否相对 Manifest 路径存在，并返回 `PIECE_EXPORT_PRESENT`。对 `real_fracture_manifest_v3.json`，预期检查结果为 Manifest、pieces、piece export、static physics contract 全部 pass。

## Round 8 final static package evidence

为静态物理最小闭环补充 `validation_result_v3.json`，记录 Manifest、schema、8 个 chunks、pieceExport 引用、static_physics contract 全部 pass，以及 9 transforms / 8 rigid chunks 和 Unity Collider/Rigidbody/Explosion 合同。目标核心闭环已达到可交付状态；未验证的 Transform animation、VAT、Alembic、skeletal FBX 仍在 Manifest warnings 中明确列出。

## Unreal MCP 建模工具 Round 1

检查结果：此前只有资产、材质、动画、Level/Actor 能力和破碎工具，没有专门的 `unreal.model.*` 建模工具族。已新增工具契约和 MCP/RPC 路由：`unreal.model.create_primitive`、`unreal.model.delete_actor`、`unreal.model.inspect`，写操作要求 `confirm=true` 或 `dryRun=true`。当前已完成注册、schema、安全门和测试；UE Python backend 的实际 primitive 创建/删除/inspect 分支仍需下一轮实现并在 UE 5.8.2 实机验证。