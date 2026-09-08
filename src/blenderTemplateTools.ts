// blenderTemplateTools.ts — high-level Blender operations on top of blender-mcp.
//
// Design (plan A — thin wrapper, no fork):
//   blender-mcp 1.9.x exposes only execute_blender_code + asset imports + queries.
//   Modeling / rigging / animation would force the LLM to write raw bpy code
//   every time, which is error-prone. Instead we register curated server-side
//   tools (blender.rig.humanoid, blender.anim.loop, ...) whose implementation is
//   a *pre-written, validated* bpy script sent to the connected Blender adapter
//   via blender.<prefix>.execute_blender_code. No blender-mcp changes, no
//   repackaging — the templates live here and can be fixed without touching the
//   addon. These tools use the code-execution channel, so they respect the same
//   evalEnabled gate as other code-execution tools.
//
// Template rules:
//   - All names/locations are injected via JSON.stringify (safe literals).
//   - Every template ends with a print(JSON) summary so the caller knows what
//     happened and is reminded to verify with get_viewport_screenshot.
import { getCachedConfig } from './config.js';
import { isAdapterTool, callAdapterTool } from './mcpAdapter.js';

export interface BlenderTemplateTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  buildCode(args: Record<string, unknown>): string;
}

const pystr = (v: unknown): string => JSON.stringify(String(v));
const pyint = (v: unknown, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
};
const pyfloat = (v: unknown, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const pybool = (v: unknown, dflt: boolean): string => (typeof v === 'boolean' ? (v ? 'True' : 'False') : dflt ? 'True' : 'False');

/** Append the standard verification reminder to a bpy script body. */
function withVerify(body: string, summaryExpr: string): string {
  return `${body}\nimport json\nprint(json.dumps(${summaryExpr}))\nprint("DONE — verify visually with blender.get_viewport_screenshot")`;
}

// ── RIGGING ──

const RIG_HUMANOID: BlenderTemplateTool = {
  name: 'blender.rig.humanoid',
  description:
    'Create a standard humanoid armature (root/hips/spine/chest/neck/head, arms+legs with .L/.R) at a chosen scale and ' +
    'bind it to a mesh with automatic weights. Use rig.auto_weights to rebind later. Verify with get_viewport_screenshot.',
  inputSchema: {
    type: 'object',
    properties: {
      mesh: { type: 'string', description: 'Mesh object name to bind (default: active object)' },
      rigName: { type: 'string', description: 'Name for the new armature (default: HumanoidRig)' },
      height: { type: 'number', description: 'Character height in meters, roughly (default 1.75)', minimum: 0.1 },
    },
  },
  buildCode(args) {
    const mesh = args.mesh ? pystr(args.mesh) : 'bpy.context.active_object.name';
    const rigName = pystr(args.rigName || 'HumanoidRig');
    const H = pyfloat(args.height, 1.75);
    // Body already includes its own JSON summary + verify hint, so no withVerify().
    return `import bpy, json
from mathutils import Vector
H = ${H}
# locate mesh
mesh_name = ${mesh}
mesh = bpy.data.objects.get(mesh_name)
if mesh is None or mesh.type != 'MESH':
    raise RuntimeError(f'mesh not found / not a mesh: {mesh_name}')
# clean any existing rig with the same name
if ${rigName} in [o.name for o in bpy.data.objects]:
    old = bpy.data.objects[${rigName}]
    bpy.data.objects.remove(old, do_unlink=True)
arm_data = bpy.data.armatures.new(${rigName})
rig = bpy.data.objects.new(${rigName}, arm_data)
bpy.context.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='EDIT')
# (name, head(XYZ in m), tail(XYZ in m), parent name)
bones = [
  ('root',        ( 0,   0,  0.02*H), ( 0,    0,   0.06*H), None),
  ('hips',        ( 0,   0,  0.06*H), ( 0,    0,   0.52*H), 'root'),
  ('spine',       ( 0,   0,  0.52*H), ( 0,    0,   0.66*H), 'hips'),
  ('chest',       ( 0,   0,  0.66*H), ( 0,    0,   0.76*H), 'spine'),
  ('neck',        ( 0,   0,  0.76*H), ( 0,    0,   0.82*H), 'chest'),
  ('head',        ( 0,   0,  0.82*H), ( 0,    0,   0.90*H), 'neck'),
  ('shoulder.L',  (-0.10*H, 0, 0.75*H), (-0.18*H, 0, 0.75*H), 'chest'),
  ('upper_arm.L', (-0.18*H, 0, 0.75*H), (-0.24*H, 0, 0.62*H), 'shoulder.L'),
  ('forearm.L',   (-0.24*H, 0, 0.62*H), (-0.24*H, 0, 0.48*H), 'upper_arm.L'),
  ('hand.L',      (-0.24*H, 0, 0.48*H), (-0.24*H, 0, 0.44*H), 'forearm.L'),
  ('shoulder.R',  ( 0.10*H, 0, 0.75*H), ( 0.18*H, 0, 0.75*H), 'chest'),
  ('upper_arm.R', ( 0.18*H, 0, 0.75*H), ( 0.24*H, 0, 0.62*H), 'shoulder.R'),
  ('forearm.R',   ( 0.24*H, 0, 0.62*H), ( 0.24*H, 0, 0.48*H), 'upper_arm.R'),
  ('hand.R',      ( 0.24*H, 0, 0.48*H), ( 0.24*H, 0, 0.44*H), 'forearm.R'),
  ('thigh.L',     (-0.08*H, 0, 0.50*H), (-0.08*H, 0, 0.28*H), 'hips'),
  ('shin.L',      (-0.08*H, 0, 0.28*H), (-0.08*H, 0, 0.06*H), 'thigh.L'),
  ('foot.L',      (-0.08*H, 0, 0.06*H), (-0.03*H, 0.03*H, 0.02*H), 'shin.L'),
  ('thigh.R',     ( 0.08*H, 0, 0.50*H), ( 0.08*H, 0, 0.28*H), 'hips'),
  ('shin.R',      ( 0.08*H, 0, 0.28*H), ( 0.08*H, 0, 0.06*H), 'thigh.R'),
  ('foot.R',      ( 0.08*H, 0, 0.06*H), ( 0.03*H, 0.03*H, 0.02*H), 'shin.R'),
]
created = []
for name, head, tail, parent in bones:
    eb = arm_data.edit_bones.new(name)
    eb.head = Vector(head)
    eb.tail = Vector(tail)
    if parent:
        eb.parent = arm_data.edit_bones[parent]
    created.append(name)
bpy.ops.object.mode_set(mode='OBJECT')
# bind with automatic weights
mesh.select_set(True)
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
try:
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    bind = 'ARMATURE_AUTO ok'
except Exception as e:
    bind = f'auto weights failed: {e}'
print(json.dumps({'rig': ${rigName}, 'mesh': mesh.name, 'bones': len(created), 'bind': bind}, ensure_ascii=False))
print("DONE — verify visually with blender.get_viewport_screenshot")`;
  },
};

const RIG_AUTO_WEIGHTS: BlenderTemplateTool = {
  name: 'blender.rig.auto_weights',
  description:
    'Bind an already-created mesh to an armature with Blender automatic weights. '
    + 'Mesh must be a mesh, rig must be an armature. Verify with get_viewport_screenshot.',
  inputSchema: {
    type: 'object',
    properties: {
      mesh: { type: 'string', description: 'Mesh object name (default: active object)' },
      rig: { type: 'string', description: 'Armature object name (default: active armature if selection has one)' },
    },
  },
  buildCode(args) {
    const meshArg = args.mesh ? pystr(args.mesh) : 'bpy.context.active_object.name';
    const rigArg = args.rig ? pystr(args.rig) : '""';
    return withVerify(
      `import bpy, json
mesh = bpy.data.objects.get(${meshArg})
rig = bpy.data.objects.get(${rigArg}) if ${rigArg} else None
if rig is None:
    rig = bpy.context.active_object if bpy.context.active_object and bpy.context.active_object.type == 'ARMATURE' else None
if mesh is None or mesh.type != 'MESH':
    raise RuntimeError('mesh not found / not a mesh')
if rig is None or rig.type != 'ARMATURE':
    raise RuntimeError('rig not found / not an armature (pass rig="<name>")')
if mesh.parent is not None:
    mesh.parent = None
    mesh.matrix_parent_inverse = rig.matrix_world.inverted()
mesh.select_set(True)
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
try:
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    status = 'bound ok'
except Exception as e:
    status = f'auto weights failed: {e}'
print(json.dumps({'mesh': mesh.name, 'rig': rig.name, 'status': status}, ensure_ascii=False))
print("DONE — verify visually with blender.get_viewport_screenshot")`,
      `{'mesh': mesh.name, 'rig': rig.name, 'status': status}`,
    );
  },
};

// ── ANIMATION ──

const ANIM_LOOP: BlenderTemplateTool = {
  name: 'blender.anim.loop',
  description:
    'Create a looping keyframe animation (action) on an armature: idle (subtle breathing) or walk (leg/arm swing). ' +
    'The first and last keyframes match so the loop is seamless in the NLA/Animation editors. ' +
    'Verify with get_viewport_screenshot.',
  inputSchema: {
    type: 'object',
    properties: {
      rig: { type: 'string', description: 'Armature object name (default: active)' },
      actionName: { type: 'string', description: 'Action name (default: IdleLoop / WalkLoop)' },
      motion: { type: 'string', enum: ['idle', 'walk'], description: 'Motion template (default idle)' },
      frames: { type: 'number', description: 'Loop length in frames (default 40; walk ~ 60)', minimum: 4 },
      amplitude: { type: 'number', description: 'Motion amplitude scale (default 1.0)', minimum: 0.1 },
    },
  },
  buildCode(args) {
    const rigArg = args.rig ? pystr(args.rig) : 'bpy.context.active_object.name';
    const motion = args.motion === 'walk' ? 'walk' : 'idle';
    const actionName = pystr(args.actionName || (motion === 'walk' ? 'WalkLoop' : 'IdleLoop'));
    const frames = Math.max(4, pyint(args.frames, motion === 'walk' ? 60 : 40));
    const amp = pyfloat(args.amplitude, 1.0);
    return withVerify(
      `import bpy, json, math
rig = bpy.data.objects.get(${rigArg})
if rig is None or rig.type != 'ARMATURE':
    raise RuntimeError('armature not found (pass rig="<name>")')
# Blender 5.x removed Action.fcurves (Action Slots/layers API), so the old
# "clear fcurves then re-key" pattern no longer works. Rebuild the action
# instead: remove any previous copy and let keyframe_insert create fcurves.
old_action = bpy.data.actions.get(${actionName})
if old_action is not None:
    bpy.data.actions.remove(old_action)
action = bpy.data.actions.new(${actionName})
rig.animation_data_create()
old_action = rig.animation_data.action
rig.animation_data.action = action
MOTION = ${pystr(motion)}
AMP = ${amp}
FRAMES = ${frames}
bones = {b.name: b for b in rig.pose.bones}
def need(*names):
    missing = [n for n in names if n not in bones]
    if missing:
        raise RuntimeError('required bones missing for motion template: ' + ', '.join(missing))
for f in range(FRAMES):
    t = f / FRAMES * math.tau
    bpy.context.scene.frame_set(f)
    if MOTION == 'idle':
        need('spine', 'chest', 'head', 'upper_arm.L', 'upper_arm.R')
        bones['spine'].rotation_euler.x = 0.04 * AMP * math.sin(t)
        bones['chest'].rotation_euler.x = 0.06 * AMP * math.sin(t + 0.5)
        bones['head'].rotation_euler.x = 0.03 * AMP * math.sin(t + 1.0)
        bones['upper_arm.L'].rotation_euler.x = 0.05 * AMP * math.sin(t)
        bones['upper_arm.R'].rotation_euler.x = 0.05 * AMP * math.sin(t)
    else:  # walk
        need('thigh.L', 'thigh.R', 'shin.L', 'shin.R', 'upper_arm.L', 'upper_arm.R', 'spine')
        sw = 0.55 * AMP
        bones['thigh.L'].rotation_euler.x = sw * math.sin(t)
        bones['thigh.R'].rotation_euler.x = sw * math.sin(t + math.pi)
        bones['shin.L'].rotation_euler.x = max(0.0, 0.35 * AMP * math.sin(t + 0.6))
        bones['shin.R'].rotation_euler.x = max(0.0, 0.35 * AMP * math.sin(t + math.pi + 0.6))
        bones['upper_arm.L'].rotation_euler.x = -0.4 * AMP * math.sin(t)
        bones['upper_arm.R'].rotation_euler.x = -0.4 * AMP * math.sin(t + math.pi)
        bones['spine'].rotation_euler.x = 0.05 * AMP * math.cos(t + 1.5)
    for pb in rig.pose.bones:
        if pb.rotation_euler != (0.0, 0.0, 0.0):
            pb.keyframe_insert(data_path='rotation_euler', frame=f)
# end frame copies frame 0 for a seamless loop
bpy.context.scene.frame_set(FRAMES - 1)
f0 = {}
for pb in rig.pose.bones:
    f0[pb.name] = pb.rotation_euler.copy()
bpy.context.scene.frame_set(0)
for pb in rig.pose.bones:
    if pb.name in f0:
        pb.rotation_euler = f0[pb.name]
        pb.keyframe_insert(data_path='rotation_euler', frame=0)
print(json.dumps({'rig': rig.name, 'action': action.name, 'motion': MOTION, 'frames': FRAMES}, ensure_ascii=False))
print("DONE — verify visually with blender.get_viewport_screenshot")`,
      `{'rig': rig.name, 'action': action.name, 'motion': MOTION, 'frames': FRAMES}`,
    );
  },
};

// ── MODELING ──

const MESH_PRIMITIVE: BlenderTemplateTool = {
  name: 'blender.mesh.primitive',
  description:
    'Create a primitive mesh (cube/sphere/cylinder/plane/cone/torus/monkey) at a location, with an optional '
    + 'bevel+subdivision modifier pipeline for an immediate "game-ready low-ish poly" look. Returns the object name.',
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['cube', 'sphere', 'cylinder', 'plane', 'cone', 'torus', 'monkey'],
        description: 'Primitive type (default cube)',
      },
      name: { type: 'string', description: 'Object name (default: auto)' },
      size: { type: 'number', description: 'Scale/size (default 1)', minimum: 0.01 },
      location: { type: 'array', items: { type: 'number' }, description: 'XYZ position [x,y,z] (default [0,0,0])' },
      segments: { type: 'number', description: 'Sphere/cylinder/cone spans (default 32), torus major segments (default 32)', minimum: 3 },
      smooth: { type: 'string', enum: ['none', 'bevel-shade'], description: 'Post-process: none or bevel+shade_smooth (default none)' },
    },
  },
  buildCode(args) {
    const type = String(args.type || 'cube').toLowerCase();
    const valid = ['cube', 'sphere', 'cylinder', 'plane', 'cone', 'torus', 'monkey'];
    if (!valid.includes(type)) throw new Error(`blender.mesh.primitive: type must be one of ${valid.join('/')}`);
    const size = pyfloat(args.size, 1.0);
    const segs = Math.max(3, pyint(args.segments, 32));
    let loc = '[0,0,0]';
    if (Array.isArray(args.location) && args.location.length === 3) {
      loc = `[${args.location.map((v) => pyfloat(v, 0)).join(', ')}]`;
    }
    const smooth = args.smooth === 'bevel-shade';
    const ops: Record<string, string> = {
      cube: `bpy.ops.mesh.primitive_cube_add(size=${size * 2}, location=(${loc.replace('[', '').replace(']', '')}))`,
      sphere: `bpy.ops.mesh.primitive_uv_sphere_add(radius=${size / 2}, segments=${segs}, ring_count=${(segs / 2) | 0}, location=(${loc.replace('[', '').replace(']', '')}))`,
      cylinder: `bpy.ops.mesh.primitive_cylinder_add(radius=${size / 2}, depth=${size}, vertices=${segs}, location=(${loc.replace('[', '').replace(']', '')}))`,
      plane: `bpy.ops.mesh.primitive_plane_add(size=${size * 2}, location=(${loc.replace('[', '').replace(']', '')}))`,
      cone: `bpy.ops.mesh.primitive_cone_add(radius1=${size / 2}, depth=${size}, vertices=${segs}, location=(${loc.replace('[', '').replace(']', '')}))`,
      torus: `bpy.ops.mesh.primitive_torus_add(major_radius=${size / 2}, minor_radius=${size / 8}, major_segments=${segs}, minor_segments=${Math.max(8, (segs / 4) | 0)}, location=(${loc.replace('[', '').replace(']', '')}))`,
      monkey: `bpy.ops.mesh.primitive_monkey_add(size=${size / 2}, location=(${loc.replace('[', '').replace(']', '')}))`,
    };
    const rename = args.name ? `bpy.context.active_object.name = ${pystr(args.name)}
` : '';
    const smoothBlock = smooth
      ? `obj = bpy.context.active_object
mod = obj.modifiers.new(name='Bevel', type='BEVEL')
mod.width = max(0.001, ${Math.min(0.1, size / 40)})
mod.segments = 2
bpy.ops.object.shade_smooth()
`
      : '';
    return withVerify(
      `import bpy, json
${ops[type]}
obj = bpy.context.active_object
${rename}${smoothBlock}print(json.dumps({'name': obj.name, 'type': '${type}', 'verts': len(obj.data.vertices)}, ensure_ascii=False))`,
      `{'name': obj.name, 'type': '${type}', 'verts': len(obj.data.vertices)}`,
    );
  },
};

const MESH_BOOLEAN: BlenderTemplateTool = {
  name: 'blender.mesh.boolean',
  description:
    'Boolean-modify object A with object B (DIFFERENCE/UNION/INTERSECT). The modifier is applied. Verify with get_viewport_screenshot.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Object name to modify (default: active)' },
      cutter: { type: 'string', description: 'Object name used as the boolean cutter (required)' },
      operation: { type: 'string', enum: ['DIFFERENCE', 'UNION', 'INTERSECT'], description: 'Boolean operation (default DIFFERENCE)' },
    },
  },
  buildCode(args) {
    if (!args.cutter) throw new Error('blender.mesh.boolean: cutter is required');
    const target = args.target ? pystr(args.target) : 'bpy.context.active_object.name';
    const cutter = pystr(args.cutter);
    const op = String(args.operation || 'DIFFERENCE').toUpperCase().replace('-', '_');
    const validOps = ['DIFFERENCE', 'UNION', 'INTERSECT'];
    if (!validOps.includes(op)) throw new Error(`blender.mesh.boolean: operation must be one of ${validOps.join('/')}`);
    return withVerify(
      `import bpy, json
a = bpy.data.objects.get(${target})
b_obj = bpy.data.objects.get(${cutter})
if a is None or a.type != 'MESH': raise RuntimeError('target not found / not a mesh')
if b_obj is None or b_obj.type != 'MESH': raise RuntimeError('cutter not found / not a mesh')
mod = a.modifiers.new(name='BoolCut', type='BOOLEAN')
mod.operation = '${op}'
mod.object = b_obj
bpy.context.view_layer.objects.active = a
a.select_set(True)
bpy.ops.object.modifier_apply(modifier='BoolCut')
print(json.dumps({'target': a.name, 'cutter': b_obj.name, 'operation': '${op}'}, ensure_ascii=False))
print("DONE — verify visually with blender.get_viewport_screenshot")`,
      `{'target': a.name, 'cutter': b_obj.name, 'operation': '${op}'}`,
    );
  },
};

// ── EXPORT ──

const SCENE_EXPORT: BlenderTemplateTool = {
  name: 'blender.scene.export',
  description:
    'Export the current scene (or selected objects) to FBX or GLB at a path on the machine running Blender. ' +
    'Use to push assets into Unity/Godot pipelines (e.g. %TEMP% or a project Assets folder). Returns the file path.',
  inputSchema: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['fbx', 'glb'], description: 'Export format (default fbx)' },
      path: { type: 'string', description: 'Absolute output file path (default C:/tmp/<scene>.<ext>)' },
      selectedOnly: { type: 'boolean', description: 'Export only selected objects (default false = whole scene)' },
    },
  },
  buildCode(args) {
    const fmt = args.format === 'glb' ? 'glb' : 'fbx';
    const selectedOnly = pybool(args.selectedOnly, false);
    const path = args.path ? pystr(args.path) : '';
    const setSel = selectedOnly === 'True' ? 'bpy.ops.object.select_all(action="DESELECT")\nbpy.ops.object.select_all(action="SELECT")\n' : '';
    return withVerify(
      `import bpy, json, os
scene = bpy.context.scene
out = ${path}
if not out:
    out = os.path.join('C:/tmp', (scene.name or 'scene') + ('.fbx' if '${fmt}' == 'fbx' else '.glb'))
os.makedirs(os.path.dirname(out), exist_ok=True) if os.path.dirname(out) else None
${setSel}if '${fmt}' == 'fbx':
    bpy.ops.export_scene.fbx(filepath=out, use_selection=${selectedOnly})
else:
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=${selectedOnly})
size = os.path.getsize(out) if os.path.exists(out) else 0
print(json.dumps({'format': '${fmt}', 'path': out, 'bytes': size}, ensure_ascii=False))
print("DONE — asset written, ready to import into Unity/Godot")`,
      `{'format': '${fmt}', 'path': out, 'bytes': size}`,
    );
  },
};

const TOOLS: BlenderTemplateTool[] = [
  RIG_HUMANOID,
  RIG_AUTO_WEIGHTS,
  ANIM_LOOP,
  MESH_PRIMITIVE,
  MESH_BOOLEAN,
  SCENE_EXPORT,
];

export function getBlenderTemplateTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

export function isBlenderTemplateTool(toolName: string): boolean {
  return TOOLS.some((t) => t.name === toolName);
}

/**
 * Execute a curated Blender template on the first connected Blender adapter
 * (config.mcpServers order, e.g. blender → blender2). Respects evalEnabled — the
 * underlying channel is arbitrary code execution.
 */
export async function runBlenderTemplateTool(toolName: string, args: Record<string, unknown>): Promise<string> {
  const tool = TOOLS.find((t) => t.name === toolName);
  if (!tool) throw new Error(`unknown blender template tool: ${toolName}`);
  const cfg = getCachedConfig();
  const prefixes = (cfg.mcpServers ?? []).map((s) => s.toolsPrefix ?? s.name);
  let code: string;
  try {
    code = tool.buildCode(args);
  } catch (err: any) {
    throw new Error(`${toolName}: ${err?.message ?? String(err)}`);
  }
  for (const prefix of prefixes) {
    const execTool = `${prefix}.execute_blender_code`;
    if (isAdapterTool(execTool)) {
      const text = await callAdapterTool(execTool, { code });
      return text;
    }
  }
  throw new Error(
    `${toolName}: no connected Blender adapter (started Blender with the blender_mcp addon?) — checked prefixes: ${prefixes.join(', ') || '(none configured)'}`,
  );
}