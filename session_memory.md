# Session Memory — SimpleMcpServer 开发会话记忆

> 作用:记录本仓库开发过程中的**决策**、**踩坑根因**与**操作手册**,供后续会话快速恢复上下文。
> 更新规则:每次会话结束时追加;踩坑记录必须包含【现象 / 根因 / 修复】三段。
> 注:本文件含本机路径与内部细节,默认不提交 git(见 .gitignore 的 SessionMemory 段)。

---

## 0. 项目全貌(一次性看明白)

```
AI/Agent ──MCP(SSE /mcp、Streamable HTTP /mcp-stream、直连 JSON-RPC /rpc)──▶ SimpleMcpServer(Node/TS)
                                                                                ├─▶ WebSocket ◀── Unity 桥(SimpleMCPBridge, C#)
                                                                                │                ├── Godot 桥(SimpleMCPBridge_Godot, GDScript)
                                                                                ├─▶ WebSocket ◀── /ab 资源包、/rpc 脚本调用
                                                                                └─▶ MCP client ──▶ blender-mcp(uvx) ──socket(9876/9877)──▶ Blender addon
```

- **仓库** `H:\ai_works\SimpleMcpServer`;兄弟仓库 `H:\ai_works\SimpleMCPBridge`(Unity)、`H:\ai_works\SimpleMCPBridge_Godot`。
- 端口:服务器 45678;Blender 实例端口 = 9875+N(实例1=9876, 实例2=9877)。
- 提交风格:版本标签 `0.0.x.y + 动词(description)`,如 `0.0.7.0 add : web search multi-provider ...`。
- 配置文件:`config.json`(gitignored,有真实密钥);模板 `config.json.template`(全占位符)。

---

## 1. 近期决策记录(2026-09-08)

### D1. Web 搜索 → 多 provider 链 + 自动探测(0.0.7.0)
- 背景:原只有 DDG,不支持中文;用户公司网络可过 Google、大陆不可过。
- 决策:按 `config.webSearch.order` 链式 fallback:`serper → google(需 key) → bing → ddg-html → ddg-lite`;中文查询强制 CJK→zh-CN locale;有凭据的 provider(serper/google)启动时做 HEAD 可达性探测,失败自动跳过。
- **关键事实**:Google Custom Search JSON API 已**对新用户关闭**(2027-01-01 旧 key 全废),所以控制台看不到"全网搜索"不是网络问题;serper.dev 是 Google 索引代理,免费 2500 次/月,无需信用卡 → **推荐 serper**。
- 用户实际配置:serper key 已填,`google` apiKey/cx 留空。

### D2. 服务器进程显示 → 可见 cmd 窗口
- 决策:服务器必须跑在用户可见的独立 cmd 窗口(`start-visible.bat`),不依赖 agent 会话。重启 = 关旧实例(cmd 窗口 + node)→ 重新 `Start-Process cmd /c start-visible.bat`。

### D3. evalEnabled 门控覆盖范围
- 决策:`editor.eval`、`*.execute_blender_code`(危险工具)、以及**新建的 blender 模板工具**全部受 `config.evalEnabled` 门控——列表隐藏 + 执行拒绝双保险。用户配置 `evalEnabled: true`(建模/骨骼/动作的前提)。

### D4. Blender 高层操作 → 方案 A(轻量模板层)(0.0.8.0 已提交 fdff3ee)
- 决策:**不 fork blender-mcp**。在 SimpleMcpServer 侧注册 `blender.rig.* / blender.anim.* / blender.mesh.* / blender.scene.* / blender.body.*` 模板工具,内部调 `blender.<prefix>.execute_blender_code` 发送**预写好的 bpy 脚本**。
- 理由:免打包/no-fork/no-addon 改动;AI 只需业务参数不写 bpy;模板经人工验证,质量稳定;模板 bug 改自己仓库即可。

### D6. 动物体块工具 blender.body.build(0.0.9.0 待提交)
- 决策:用户要求"基础形体工具除了人形还要常见四足动物" → 参数化通用体块构建器 `blender.body.build`。
- 思路:**preset 表驱动**(`QUAD_PRESETS`:dog/horse/cat/wolf/cow;`preset=human` 走 biped 分支)所有几何参数都是**相对肩高 H 的比例系数**,改动物=加一行预设。体块沿**同一份骨架数据**摆放(躯干/头/颈/四肢/尾各部件贴着骨骼),因此 ARMATURE_AUTO 自动权重天然贴合。
- 输出:CreatureBody mesh + CreatureRig 骨架(dog 系 28 骨;human 20 骨)+ ARMATURE_AUTO 权重;`rigName/meshName/bind/resetBoneRoll` 可自定义;重复调用同名重建(先删旧对象),不误删场景其它对象。
- 四足骨架约定:**+Y=尾/臀、-Y=头/肩(Blender 前向)**;肩高= `height` 参数,地面 z=0。骨架命名:root→pelvis→spine1..3→shoulder→neck1..2→head;前腿 front_shoulder/upper_front/lower_front/front_paw ×L.R;后腿 hip/thigh/calf/hind_paw ×L.R;tail1..3。
- 朝向注意:Blender 前向是 -Y,Unity 前向是 +Z——FBX 导入 Unity 需查 forward 轴映射(待验证,见待办)。
- 模板工具清单(7):`rig.humanoid`、`rig.auto_weights`、`anim.loop`(idle/walk)、`mesh.primitive`、`mesh.boolean`、`scene.export`(fbx/glb)、`body.build`(四足/人形预设)。
- 已端到端验证 7/7 成功(dog/horse/cat/wolf/cow/human 五预设 + 自定义命名 + 同名重建 + 权重统计)。

### D5. 仓库可提交状态(0.0.7.0 + 0.0.7.1,已 push)
- 用户自行 push;adapter 首连重连修复、死代码清理、README allowedIps 同步。
- Agnes API key 仅一个,用户评估风险可接受**不轮换**(key 从未进 git,历史扫描干净)。

---

## 2. 踩坑记录(重点!!)

### P1. Blender 5.2 移除了 `Action.fcurves`(最新)
- **现象**:`blender.anim.loop` 报 `'Action' object has no attribute 'fcurves'`。
- **根因**:Blender 4.x 引入 Action Slots/layers 新 API,5.2 彻底删掉旧的 `action.fcurves.clear()` 用法(`hasattr(Action,'fcurves')==False`)。
- **修复**:放弃 clear-and-rekey;改为"删旧 action → `bpy.data.actions.new()` → 设 `rig.animation_data.action` → 让 `keyframe_insert` 自动建 fcurve"。这比旧写法更兼容 5.x。

### P2. 模板生成器里 Python 逻辑混进 JS 表达式
- **现象 1**:`blender.mesh.primitive` 报 `bpy_struct: this type doesn't support IDProperties`。
  - 根因:rename 分支生成了 `if 'name' in bpy.context:` —— Python `in` 触发 IDProperty 检查而崩;且逻辑冗余(TS 已判过)。
  - 修复:改为无条件 `bpy.context.active_object.name = ...`。
- **现象 2**:tsc 报 `error TS1005 '(' expected` 整片语法错误。
  - 根因:`${segs // 2}` 里 `//` 在 TS 里是注释,causes template literal 未闭合;`selectedOnly === 'True' and 'True' or 'False'` 把 Python 语法写进了 JS 表达式。
  - 修复:`${(segs/2)|0}` 代替 `//`;布尔直接插值 `use_selection=${selectedOnly}`(已是 'True'/'False' 字符串)。
- **教训**:拼 Python 代码时,`${...}` 内只能是 **TS 表达式**;想表达整除用 `| 0`,想表达布尔直接插字符串;生成后先喂给 execute_blender_code 单测再依赖。

### P3. 启动日志 `serper:probe-pending` 误导(显示缺陷,非故障)
- **现象**:启动日志恒显 `probe-pending`,用户误以为 serper 没通。
- **根因**:探测是异步 HEAD(≤5s),启动打印 summary 时探测未返回;且探测完成后**不补打日志**。
- **修复**:probeHost 结算时补日志 `web.search: 'serper' reachability probe → reachable/unreachable`。实际 serper 一直通(实测 `via serper`)。

### P4. blender-mcp 适配器首次连接失败即永久失效(0.0.7.1 已修)
- **现象**:Blender 未开时启动 MCP,适配器失败后再开 Blender 也连不上,只能重启整个服务器。
- **根因**:`startOne` 首次连接失败路径只 `return`,没进重连循环。
- **修复**:catch 路径调 `scheduleReconnect(cfg)`;重连退避 10s→30s→60s→120s;`cfg.enabled===false` 时 early-return。

### P5. server.ts 顶层 retryQueue 误判"死代码"
- 审查时一度标记 server.ts 的 retryQueue 为死代码,核对后**它是活跃的**(register_tools flush / bridge close push / 30s 宽限 timer);只删了 `bridgeState.ts` 里真正无人引用的那份。**教训:删"死代码"前必须 git grep 全仓验证引用。**

### P6. Invoke-RestMethod 发送中文查询变 `?? ????`
- 根因:PW 的 Invoke-RestMethod 非 UTF-8 编码 body。
- 修复(仅测试侧):用 Node `fetch` + `Content-Type: application/json; charset=utf-8` 直连 /rpc 测试 web.search。**不是服务器 bug。**

### P7. Unity/Godot 桥审查发现的高危 bug(未修复,仅审计)
- Unity:`BridgeClient.cs:303` server_info 布尔解析(需 `"` 前缀)、重连风暴、AIRequest 90s 超时死代码、KeyboardTools 零位弹出物理键、InputActionTools sticky bits、SequenceRunner 泄漏、MouseDeviceTools 像素/桌面不匹配、`HandlerUtils.ParseJsonValue` List/Dict 分支不可达致参数静默丢失、浮点 NaN 破坏整包、AB/Shader 生命周期竞态、BuildingHandler Lua 注入、asmdef 硬依赖 NGUI/UniEnc/InstantReplay。
- Godot:`InputHandler.gd:12-17` 手柄映射错位、`CryptoHelper.gd` 缺 `(size-16)%16==0` 校验且 `_rcon[i/8]` 浮点除、`GameHandler.gd:238-254` 序列裁剪 KeyError、`project.godot` 缺失。
- 计划:SimpleMCPBridge 修复排在 Blender 任务之后,用户尚未启动。

### P8. 权重检查脚本的 `break` 陷阱(测试侧,非模板 bug)
- **现象**:第二次跑 `humanoid` 权重统计,每组 `verts` 都是 1,看似权重全丢。
- **根因**:统计脚本 `if any(...): count+=1; break` —— `break` 跳出的是**外层 verts 循环**,每组只数到 1 个顶点;第一次用双层循环(内层 break)是对的。
- **教训**:Blender 侧统计脚本先小样本验证输出形状再全量跑;正确写法:
  ```python
  for g in mesh.vertex_groups:
      count = 0
      for v in mesh.data.vertices:
          for vg in v.groups:
              if vg.group == g.index and vg.weight > 0.01:
                  count += 1
                  break  # 内层 break:每顶点只计一次
  ```

### P9. 基础体块打型(BB-blocking)人形流程已验证(可复用的配方)
- **结论**:用 primitive 拼人形(16 部件合并 → 一个 mesh)→ `rig.humanoid` 绑定 → 权重分布合理,比单一圆柱效果好得多。
- 拼装配方(身高 1.75m):头=球(r0.135)@1.62;颈=柱(r0.05,d0.10)@1.50;躯干=柱(r0.17,d0.55)@1.13(scaleY 0.82);盆骨=扁柱@0.86;臂=上臂柱(L/R)+前臂柱+手球,肩 @±0.33;腿=大腿柱(r0.085,d0.45)@0.60+小腿柱@0.17+脚立方(scale 0.11/0.20/0.07)@0.035;`bpy.ops.object.join()` 合并(以 Head 为 active),命名 HumanoidBody。
- 绑定后顶点组分布(head 330、forearm/hand 各 330/266、hips 249、thigh 143…全部 20 组有值)——**体块越贴近骨骼,权重越分散合理**。
- 注意:`primitive_cylinder_add` 的 radius/depth 是直径参数语义(`size*2` 是 cube 边长、cyc depth 即总高);`transform_apply(scale=True)` 让 scale 落到顶点上,自动权重才准确。

### P10. EditBone 引用跨模式悬垂(重!)⚠️ 教训核心
- **现象**:`blender.body.build` 生成 dog 时,`UpperFront/LowerFront/Thigh/Calf .L/.R` **部分圆柱缺失**(先只有 3 个 cyl,后来 Thigh.L 之后全部 `CYL_SKIP zero axis (0,0,0),(0,0,0)`),网格 bounding box Z 爆 ±21223m 或权重腿骨全 0。
- **根因链**:①先怀疑四元数旋转 `z.rotation_difference(v.normalized())` 对**反平行轴**(竖直腿骨 v≈±Z)返回 NaN → 换用 bmesh 建柱(make_cyl,完全绕开旋转) ✅;②但圆柱仍缺 → 追到 **`parts` 里直接存了 `eb.head`/`eb.tail`(EditBone 的 Vector 引用)**:退出 EDIT mode 后 edit_bones 内存被释放/重排,对**部分**骨骼(碰巧)还能读到旧值,对另一些(Thigh.L 起)读到垃圾 → 零长度轴被 `L<1e-6` 跳过。
- **修复**:在 EDIT mode 内立刻 `_h=tuple(eb.head); _t=tuple(eb.tail)` 固化纯值,再存进 parts;`bone_ball/bone_cube` 同理(它们用 `Vector(eb.tail)+offset`,若直接存 Vector 引用同样危险)。
- **通用教训**:**任何跨越 `mode_set('EDIT'→'OBJECT')` 的数据都必须提取成 tuple/float 值拷贝**,不要保留 EditBone/Vector 引用——Blender 的 Lazy 内存模型下悬垂引用"部分有效"极具迷惑性(前面 3 个 Cyl OK、后面全 SKIP 就因内存重排)。诊断手段:`print` 部件清单 + bound_box + `CYL_SKIP` 打点,逐部件定位。

---

## 3. 操作手册(高频命令)

### 3.1 重启服务器(可见 cmd 窗口)
```powershell
$c = Get-NetTCPConnection -LocalPort 45678 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($c) { Stop-Process -Id $c.OwningProcess -Force }
# 关掉旧 cmd 窗口(可选):匹配 start-visible 的 cmd.exe 进程
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "start-visible.bat" -WorkingDirectory "H:\ai_works\SimpleMcpServer" -PassThru
Start-Sleep -Seconds 9; Get-NetTCPConnection -LocalPort 45678 -State Listen
```
> 注意:改 src 后必须 `npm run build`(tsc strict,当前 0 error)再重启,否则跑的是旧 dist。

### 3.2 启动 Blender 实例(MCP addon 随附)
```powershell
$env:BLENDER_MCP_PORT = "9876"; Start-Process -FilePath "H:\Program Files\blender-5.2.0-windows-x64\blender.exe"
```
- 或用 `scripts\start-blender-instance.ps1 -Instance N`(注意:在受限 pwsh 内嵌 pwsh 会失败,直接 Start-Process)。
- addon 源码:`C:\Users\Admin\AppData\Roaming\Blender Foundation\Blender\5.2\scripts\addons\blender_mcp.py`;启动脚本 `...\scripts\startup\blender_mcp_auto.py`。

### 3.3 端到端测试模板工具(/rpc 直连,UTF-8)
```powershell
@'
const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'blender.mesh.primitive', arguments: { type: 'cube', name: 'MCPTestCube', size: 1.0, smooth: 'bevel-shade' } } });
fetch('http://127.0.0.1:45678/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body }).then(r=>r.json()).then(console.log).catch(e=>console.error(e));
'@ | node --input-type=module -
```
- addon 状态:`blender.get_addon_status`;截图:`blender.get_viewport_screenshot`(注意:这个 addon v1.6 的**所有工具都要传 `user_prompt` 参数**,否则 pydantic 报缺参)。

### 3.4 常用查看
```powershell
git status --short; git log --oneline -6
git grep -n -E 'sk-[A-Za-z0-9]{20,}' -- .          # 密钥扫描(应无输出)
Get-Content server.log -Tail 20                     # 日志(server.log 已 gitignore)
```

---

## 4. 安全要点

- `config.json` 含**真实 Agnes API key**(`sk-JNA...`)和 serper key —— 已被 .gitignore 覆盖,模板文件只有占位符。任何改动不得把真实 key 写进跟踪文件。
- `.gitignore` 覆盖:node_modules/、dist/、.env*、config.json、logs/server logs(含 server-run.log、server.log)、ab-cache、mcp-media、**SessionMemory 段(本文件)**。
- allowedIps 实际 gate:/rpc、/sse、/mcp、WebSocket(1008 Forbidden)**和 /ab**(README 已同步修正)。
- 服务器默认监听 0.0.0.0:45678,allowedIps=127.0.0.1/::1 —— 局域网可达但工具调用被 IP 白名单挡。

---

## 5. 当前状态与待办

- **已完成**:web search 多 provider(serper 实测通)、仓库整理提交 0.0.7.0/0.0.7.1(已 push)、模板工具 7 个全部端到端验证。0.0.8.0(6 模板 + websearch 探测日志 + session_memory)已提交 fdff3ee,用户自行 push;**blender.body.build 四足/人形通用体块构建器完成并验证**(0.0.9.0 待提交):dog/horse/cat/wolf/cow 预设 + human 收编,bmesh 建柱避 NaN、EditBone 引用 tuple 固化避悬垂(P10),权重左右对称、28 骨(四足)/20 骨(人形)全覆盖。
- **待提交**:`src/blenderTemplateTools.ts`(BODY_BUILD)+ session_memory.md(D6/P10) → 建议 `0.0.9.0 add: blender.body.build (preset quadruped/biped blockout + auto weights)`。
- **待办**:README 补充模板工具章节与 config 示例;`mesh.boolean` 实测;Unity/Godot 桥修复(P7);四足 walk/trot 动作模板(拍点参数化:犬科对角两拍、蹄类四拍,可挂到 body.build 产物上);FBX 前向轴验证(Blender -Y → Unity +Z 的 forward 映射);(可选)方案 B 深度封装(改 blender-mcp server.py + addon 加原生 @mcp.tool)。
- **环境事实**:Blender 5.2.0(新 Action API)、uvx blender-mcp@1.9.1、addon v1.6、协议 v5 匹配;`bridgeConnected:false` 是正常的(桥未连时)。