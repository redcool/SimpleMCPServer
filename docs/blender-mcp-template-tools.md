# Blender MCP 模板工具(本仓库预置)

SimpleMcpServer 内置一组**高层 Blender 模板工具**(方案 A:不 fork blender-mcp,在服务端生成预写好的 bpy 脚本,经 `blender.<prefix>.execute_blender_code` 发送给 Blender addon 执行)。AI 只需提供业务参数,不必手写 Python。

> 前置:见 README「外部 MCP 适配器」接入 BlenderMCP(uvx `blender-mcp@1.9.1` 实测)。所有模板工具均受 `config.evalEnabled` 门控(列表隐藏 + 执行拒绝双保险),且每个工具都接受通用参数 `adapter` 指定目标实例前缀(`blender`/`blender2`…,省略则用配置里第一个可用实例)。

## 工具清单

| 工具 | 用途 | 状态 |
|---|---|---|
| `blender.rig.humanoid` | 生成标准人形骨架(20 骨,可指定高度/ROOT 命名) | ✅ 已验证 |
| `blender.rig.auto_weights` | 为 mesh 绑定骨架(ARMATURE_AUTO) | ✅ 已验证 |
| `blender.anim.loop` | 人形循环动画:idle(呼吸)/ walk(摆臂摆腿),首末帧无缝 | ✅ 已验证 |
| `blender.anim.quadruped` | 四足步态循环:walk(四拍)/ trot(对角两拍)/ pace(同侧两拍) | ✅ 已验证 |
| `blender.mesh.primitive` | 基础体块(cube/sphere/cylinder/cone/torus…)| ✅ 已验证 |
| `blender.mesh.boolean` | 布尔运算:DIFFERENCE/UNION/INTERSECT,apply 进网格 | ✅ 已验证 |
| `blender.body.build` | 参数化动物/人形体块构建 + 骨架 + 自动权重(preset 表驱动) | ✅ 已验证 |
| `blender.scene.export` | 导出场景/选中对象为 FBX/GLB | ✅ 已验证 |

---

## 1. blender.body.build — 通用生物体块(推荐起点)

参数化构建带骨架的动物或人形,自动权重随体块贴合骨骼。

| 参数 | 说明 | 默认 |
|---|---|---|
| `preset` | `dog` / `wolf` / `horse` / `cow` / `cat` / `human` | dog |
| `height` | 肩高(四足)/ 基准比例(m) | 预设基数 |
| `rigName` / `meshName` | 骨架/网格对象名 | CreatureRig / CreatureBody |
| `bind` | 是否 ARMATURE_AUTO 绑定 | true |
| `resetBoneRoll` | 清骨骼 roll | true |

- 四足输出:mesh `CreatureBody` + 骨架 `CreatureRig`(28 骨)+ 自动权重,权重左右对称。
- 体块沿骨架摆放 → 后续任意四足动作模板可直接绑定。
- 重复调用同名重建(自动删旧),不误删场景其它对象。
- 朝向约定:**+Y=尾/臀、-Y=头/肩**(Blender 前向),地面 z=0。

```json
{ "name": "blender.body.build", "arguments": { "preset": "horse", "height": 1.5 } }
```

## 2. blender.anim.quadruped — 四足步态循环

应用于 `body.build` 产出的四足骨架(walk/trot/pace)。

| 参数 | 说明 | 默认 |
|---|---|---|
| `gait` | `walk`(四拍 LF→RH→RF→LH)/ `trot`(对角)/ `pace`(同侧) | walk |
| `frames` | 循环帧数 | walk 40 / trot 24 / pace 20 |
| `amplitude` | 总幅度缩放 | 1.0 |
| `legSwing` | 根腿摆角(弧度) | 0.5(≈29°) |
| `kneeLift` | 摆动相屈膝 | 0.55 |
| `bodyBob` | 盆腔上下起伏(m) | 0.05 |
| `tailWag` | 尾摆幅度(弧度) | 0.35 |

```json
{ "name": "blender.anim.quadruped", "arguments": { "rig": "CreatureRig", "gait": "trot", "frames": 30 } }
```

## 3. 人形模板(rig.humanoid / anim.loop)

- `blender.rig.humanoid`:生成 20 骨标准人形(hips/spine/chest/neck/head + 四肢)。
- `blender.anim.loop`:人形 idle(呼吸)或 walk(摆腿摆臂),first/last 帧一致保证无缝循环。

```json
{ "name": "blender.anim.loop", "arguments": { "rig": "HumanoidRig", "motion": "walk", "frames": 60 } }
```

## 4. 建模辅助(mesh.primitive / mesh.boolean)

- `mesh.primitive`:快速生成基础体块(可设 type/location/size),适合搭场景。
- `mesh.boolean`:`target`(被切对象)+ `cutter`(布尔体)+ `operation`(DIFFERENCE/UNION/INTERSECT),modifier 直接 apply 进网格。

```json
{ "name": "blender.mesh.boolean", "arguments": { "target": "CutTarget", "cutter": "CutterBox", "operation": "DIFFERENCE" } }
```

## 5. blender.scene.export — 出资产给 Unity/Godot

| 参数 | 说明 | 默认 |
|---|---|---|
| `format` | `fbx` / `glb` | fbx |
| `path` | 输出绝对路径 | `C:/tmp/<scene>.<ext>` |
| `selectedOnly` | 只导出选中对象 | false |

```json
{ "name": "blender.scene.export", "arguments": { "format": "fbx", "path": "C:/tmp/dog_rig.fbx" } }
```

---

## 典型工作流:AI 一句话生成"会走的四足动物"

```text
1. blender.body.build   → preset=dog, height=0.6, bind=true        # 狗:体块+骨架+权重
2. blender.anim.quadruped → rig=CreatureRig, gait=walk             # 走步循环
3. blender.get_viewport_screenshot                                 # 目检
4. blender.scene.export → format=fbx, path=...                     # 出资产
```

## FBX 前向轴(实测记录,2026-09)

Blender 默认场景前向是 **-Y**(四足头朝 -Y,骨架 +Y=尾/臀)。`blender.scene.export` 用 Blender 标准 `axis_forward='-Y', axis_up='Z'` 导出,实测落盘结果:

- FBX `GlobalSettings`:UpAxis=**Z(+)**、FrontAxis=**Y(+)**(读取脚本:`node scripts/peek-fbx-axes.mjs`,检查任意已导出的 FBX)。
- 网格顶点包围盒与 Blender 场景坐标**逐位一致**(实测 dog:x[-0.42,0.42] y[-0.92,1.0] z[0,0.86])——几何不做任何轴交换,朝向信息只存在于 GlobalSettings 声明里。
- **对 Unity 的搬运**:Unity FBX Importer 默认开「Bake Axis Conversion」,会按 GlobalSettings 做轴转换,但最终朝向由 Unity 侧的烘培选项/旋转决定,本机无法替 Unity 打包票。首次接入请在 Unity 里导入后目检朝向,若狗头不朝目标方向,优先试 Unity Import 选项卡的轴选项,或对根骨骼补一个 90° 旋转——这是资产的**一次性映射约定**,定下来后所有 body.build 产物(骨架命名一致)复用同一约定。

---

## 已知坑(Blender 5.2 实测)

1. **`Action.fcurves` 已移除**:Blender 4.x 引入 Action Slots/layers,5.2 删除旧 API。模板内部一律用"删旧 action → `actions.new()` → `keyframe_insert` 自动建 fcurve"的新写法,工作正常。
2. **EditBone 引用跨模式悬垂**:脚本里跨 `mode_set('EDIT'→'OBJECT')` 保留的 `eb.head/eb.tail` Vector 引用可能读到垃圾(部分骨骼生效、部分变零,极具迷惑性)。模板已改为编辑模式内立即 `tuple()` 固化。
3. **`adapter` 与工具自身参数区分**:通用参数名是 `adapter`(选 Blender 实例),`target` 等是各工具自己的参数名,两者不冲突。
4. Blender 中文界面下默认对象名本地化,脚本均显式 `o.name=…`;PowerShell 传中文参数需 UTF-8。