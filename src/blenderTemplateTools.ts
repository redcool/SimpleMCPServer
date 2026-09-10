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

// ── QUADRUPED ANIMATION ──

const QUAD_ANIM: BlenderTemplateTool = {
  name: 'blender.anim.quadruped',
  description:
    'Create a looping quadruped locomotion action on an armature built by blender.body.build '
    + '(bone names front_shoulder/upper_front/hip/thigh/calf/spine/neck/tail). Gaits: walk '
    + '(4-beat lateral: LF→RH→RF→LH), trot (2-beat diagonal: LF+RH in phase), pace '
    + '(2-beat same-side). First/last frames match for a seamless loop. '
    + 'Verify with get_viewport_screenshot.',
  inputSchema: {
    type: 'object',
    properties: {
      rig: { type: 'string', description: 'Armature object name (default: active)' },
      actionName: { type: 'string', description: 'Action name (default QuadrupedWalk / QuadrupedTrot / QuadrupedPace)' },
      gait: { type: 'string', enum: ['walk', 'trot', 'pace'], description: 'Gait pattern (default walk)' },
      frames: { type: 'number', description: 'Loop length in frames (default: walk 40 / trot 24 / pace 20)', minimum: 4 },
      amplitude: { type: 'number', description: 'Master amplitude scale (default 1.0)', minimum: 0.1 },
      legSwing: { type: 'number', description: 'Root leg swing angle in radians (default 0.5 ≈ 29°)', minimum: 0.0 },
      kneeLift: { type: 'number', description: 'Knee/ankle bend during swing phase (default 0.55)', minimum: 0.0 },
      bodyBob: { type: 'number', description: 'Pelvis vertical bob in meters (default 0.05)', minimum: 0.0 },
      tailWag: { type: 'number', description: 'Tail swish amplitude in radians (default 0.35)', minimum: 0.0 },
    },
  },
  buildCode(args) {
    const rigArg = args.rig ? pystr(args.rig) : 'bpy.context.active_object.name';
    const gait = args.gait === 'trot' || args.gait === 'pace' ? args.gait : 'walk';
    const actionName = pystr(args.actionName || (gait === 'trot' ? 'QuadrupedTrot' : gait === 'pace' ? 'QuadrupedPace' : 'QuadrupedWalk'));
    const frames = Math.max(4, pyint(args.frames, gait === 'walk' ? 40 : gait === 'trot' ? 24 : 20));
    const amp = pyfloat(args.amplitude, 1.0);
    const legSwing = pyfloat(args.legSwing, 0.5);
    const kneeLift = pyfloat(args.kneeLift, 0.55);
    const bodyBob = pyfloat(args.bodyBob, 0.05);
    const tailWag = pyfloat(args.tailWag, 0.35);
    return withVerify(
      `import bpy, json, math
rig = bpy.data.objects.get(${rigArg})
if rig is None or rig.type != 'ARMATURE':
    raise RuntimeError('armature not found (pass rig="<name>")')
# Rebuild the action (Blender 5.x removed Action.fcurves — see ANIM_LOOP).
old_action = bpy.data.actions.get(${actionName})
if old_action is not None:
    bpy.data.actions.remove(old_action)
action = bpy.data.actions.new(${actionName})
rig.animation_data_create()
rig.animation_data.action = action
GAIT = ${pystr(gait)}
FRAMES = ${frames}
AMP = ${amp}
SWING = ${legSwing}
KNEE = ${kneeLift}
BOB = ${bodyBob}
WAG = ${tailWag}
bones = {b.name: b for b in rig.pose.bones}
def need(*names):
    missing = [n for n in names if n not in bones]
    if missing:
        raise RuntimeError('quadruped skeleton missing bones (did you use blender.body.build?): ' + ', '.join(missing))
# phase table: phase for each leg root (radians) — LF=front_shoulder.L, RF=front_shoulder.R, LH=hip.L, RH=hip.R
if GAIT == 'walk':
    P = {'front_shoulder.L': 0.0, 'hip.R': math.pi / 2.0, 'front_shoulder.R': math.pi, 'hip.L': 1.5 * math.pi}
elif GAIT == 'trot':
    P = {'front_shoulder.L': 0.0, 'hip.R': 0.0, 'front_shoulder.R': math.pi, 'hip.L': math.pi}
else:  # pace — same-side pairs in phase
    P = {'front_shoulder.L': 0.0, 'hip.L': 0.0, 'front_shoulder.R': math.pi, 'hip.R': math.pi}
LEGS = {
    'front_shoulder.L': ('upper_front.L', 'lower_front.L'),
    'front_shoulder.R': ('upper_front.R', 'lower_front.R'),
    'hip.L': ('thigh.L', 'calf.L'),
    'hip.R': ('thigh.R', 'calf.R'),
}
need('pelvis', 'spine2', 'shoulder', 'head', 'neck1', 'tail1', 'tail2', 'tail3', *[b for pair in LEGS.values() for b in pair], *P.keys())
for pb in rig.pose.bones:
    pb.rotation_mode = 'XYZ'
for f in range(FRAMES):
    t = f / FRAMES * math.tau
    bpy.context.scene.frame_set(f)
    for root, (knee, ankle) in LEGS.items():
        ph = P[root]
        bones[root].rotation_euler.x = SWING * math.sin(t + ph)
        kb = KNEE * max(0.0, math.sin(t + ph + 1.3))  # bend only while swinging/forward
        bones[knee].rotation_euler.x = kb
        bones[ankle].rotation_euler.x = 0.25 * kb
    bones['pelvis'].location.z = BOB * math.sin(t)
    bones['spine2'].rotation_euler.x = 0.06 * AMP * math.sin(t + 0.8)
    bones['shoulder'].rotation_euler.x = 0.035 * AMP * math.sin(t + 0.8)
    bones['head'].rotation_euler.x = 0.08 * AMP * math.sin(t + 2.2)
    bones['neck1'].rotation_euler.x = 0.04 * AMP * math.sin(t + 2.2)
    bones['tail1'].rotation_euler.z = WAG * math.sin(2.0 * t + 1.0)
    bones['tail2'].rotation_euler.z = WAG * 0.8 * math.sin(2.0 * t + 1.2)
    bones['tail3'].rotation_euler.z = WAG * 0.6 * math.sin(2.0 * t + 1.4)
    for pb in rig.pose.bones:
        if pb.rotation_euler != (0.0, 0.0, 0.0):
            pb.keyframe_insert(data_path='rotation_euler', frame=f)
        if pb.location != (0.0, 0.0, 0.0):
            pb.keyframe_insert(data_path='location', frame=f)
print(json.dumps({'rig': rig.name, 'action': action.name, 'gait': GAIT, 'frames': FRAMES}, ensure_ascii=False))
print("DONE — verify visually with blender.get_viewport_screenshot")`,
      `{'rig': rig.name, 'action': action.name, 'gait': GAIT, 'frames': FRAMES}`,
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
      selectedOnly: { type: 'boolean', description: 'Export only the objects currently selected (default false = whole scene)' },
    },
  },
  buildCode(args) {
    const fmt = args.format === 'glb' ? 'glb' : 'fbx';
    const selectedOnly = pybool(args.selectedOnly, false);
    const path = args.path ? pystr(args.path) : '';
    return withVerify(
      `import bpy, json, os
scene = bpy.context.scene
out = ${path}
if not out:
    out = os.path.join('C:/tmp', (scene.name or 'scene') + ('.fbx' if '${fmt}' == 'fbx' else '.glb'))
os.makedirs(os.path.dirname(out), exist_ok=True) if os.path.dirname(out) else None
if '${fmt}' == 'fbx':
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

// ── BODY BUILD (parameterized biped/quadruped blockout + rig + weights) ──
//
// One tool to block out a creature from primitives: body segments are placed
// along the skeleton (bones are generated from the same preset table), so the
// auto-weights land where they should. Presets are proportional parameters —
// adding an animal = adding one row to QUAD_PRESETS.
//
// Coordinate convention: +Z up, head faces -Y (Blender front). Front legs at
// y=-L/2, hind legs at y=+L/2, ground at z=0, shoulder height = H.

interface QuadPreset {
  label: string;
  note: string;
  /** shoulder height in meters — the base scale */
  H: number;
  /** body length / H (torso span) */
  bodyLen: number;
  /** body width / H */
  bodyW: number;
  /** neck length / H */
  neckLen: number;
  /** head length / H */
  headLen: number;
  /** head height / H */
  headH: number;
  /** tail length / H */
  tailLen: number;
  /** leg limb radius / H (front == hind) */
  limbR: number;
  /** front stance width / H (X offset) */
  frontW: number;
  /** hind stance width / H */
  hindW: number;
  /** horns/ears: small spheres ("ears"|"horns"|"") */
  accessories: 'ears' | 'horns' | '';
}

const QUAD_PRESETS: Record<string, QuadPreset> = {
  dog: {
    label: '狗', note: '中等体躯、立耳、中等长尾', H: 0.6,
    bodyLen: 1.6, bodyW: 0.45, neckLen: 0.4, headLen: 0.38, headH: 0.3,
    tailLen: 0.8, limbR: 0.09, frontW: 0.45, hindW: 0.5, accessories: 'ears',
  },
  horse: {
    label: '马', note: '长腿、长颈、长头、长尾', H: 1.5,
    bodyLen: 1.5, bodyW: 0.5, neckLen: 0.55, headLen: 0.5, headH: 0.22,
    tailLen: 0.9, limbR: 0.055, frontW: 0.3, hindW: 0.4, accessories: 'ears',
  },
  cat: {
    label: '猫', note: '修长、圆头、长尾、立耳', H: 0.35,
    bodyLen: 1.7, bodyW: 0.45, neckLen: 0.35, headLen: 0.38, headH: 0.4,
    tailLen: 0.8, limbR: 0.06, frontW: 0.42, hindW: 0.5, accessories: 'ears',
  },
  wolf: {
    label: '狼', note: '似狗但更高、胸更深、尾垂', H: 0.85,
    bodyLen: 1.55, bodyW: 0.5, neckLen: 0.42, headLen: 0.42, headH: 0.28,
    tailLen: 0.85, limbR: 0.08, frontW: 0.42, hindW: 0.48, accessories: 'ears',
  },
  cow: {
    label: '牛', note: '宽厚躯干、短腿、头大、角', H: 1.35,
    bodyLen: 1.35, bodyW: 0.7, neckLen: 0.35, headLen: 0.45, headH: 0.3,
    tailLen: 0.5, limbR: 0.1, frontW: 0.5, hindW: 0.62, accessories: 'horns',
  },
};

const BODY_BUILD: BlenderTemplateTool = {
  name: 'blender.body.build',
  description:
    'Block out a creature from primitives and rig it: quadruped presets (dog/wolf/horse/cow/cat) or biped ' +
    '(preset=human). Body parts are placed along the generated skeleton so auto-weights land correctly. ' +
    'Returns mesh/rig/bone/vertex-group summary. Verify with get_viewport_screenshot.',
  inputSchema: {
    type: 'object',
    properties: {
      preset: {
        type: 'string',
        enum: ['dog', 'wolf', 'horse', 'cow', 'cat', 'human'],
        description: 'Creature preset (default dog)',
      },
      height: { type: 'number', description: 'Shoulder height / base scale in meters (default: preset base)', minimum: 0.1 },
      rigName: { type: 'string', description: 'Armature object name (default CreatureRig)' },
      meshName: { type: 'string', description: 'Mesh object name (default CreatureBody)' },
      bind: { type: 'boolean', description: 'Bind mesh to rig with automatic weights (default true)' },
      resetBoneRoll: { type: 'boolean', description: 'Clear bone rolls for a clean T/stand pose (default true)' },
    },
  },
  buildCode(args) {
    const presetName = String(args.preset || 'dog');
    const biped = presetName === 'human';
    const base = QUAD_PRESETS[presetName] ?? QUAD_PRESETS.dog;
    const H = pyfloat(args.height, base.H);
    const rigName = pystr(args.rigName || 'CreatureRig');
    const meshName = pystr(args.meshName || 'CreatureBody');
    const bindFlag = pybool(args.bind, true);
    const resetRoll = pybool(args.resetBoneRoll, true);

    // Emit the preset as a python literal (numbers only — safe).
    const P = JSON.stringify({ label: base.label, H, bodyLen: base.bodyLen, bodyW: base.bodyW, neckLen: base.neckLen, headLen: base.headLen, headH: base.headH, tailLen: base.tailLen, limbR: base.limbR, frontW: base.frontW, hindW: base.hindW, accessories: base.accessories });
    const bipedFlag = biped ? 'True' : 'False';

    return `import bpy, json, math
from mathutils import Vector
# ---- parameters ----
H = ${H}          # shoulder height (base scale)
P = ${P}          # preset proportions (relative to H)
BIPED = ${bipedFlag}
RIG_NAME = ${rigName}
MESH_NAME = ${meshName}
DO_BIND = ${bindFlag}
RESET_ROLL = ${resetRoll}
# remove previous same-named build (re-running rebuilds in place)
for n in (RIG_NAME, MESH_NAME):
    old = bpy.data.objects.get(n)
    if old is not None:
        bpy.data.objects.remove(old, do_unlink=True)
J = lambda v: (v * H,)  # unused placeholder for clarity

def cyl(name, r, d, loc):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=d, vertices=24, location=Vector(loc))
    o = bpy.context.active_object
    o.name = name
    o.select_set(False)
    return o

def sph(name, r, loc, scale=None):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, segments=24, ring_count=12, location=Vector(loc))
    o = bpy.context.active_object
    if scale is not None:
        o.scale = Vector(scale)
        bpy.ops.object.transform_apply(scale=True)
    o.name = name
    o.select_set(False)
    return o

def cube(name, sz, loc):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=Vector(loc))
    o = bpy.context.active_object
    o.scale = Vector(sz)
    bpy.ops.object.transform_apply(scale=True)
    o.name = name
    o.select_set(False)
    return o

# ---- skeleton definition (name, head, tail, parent) ----
S = H
L = S * P['bodyLen']          # body span
BW = S * P['bodyW']           # body width
HN = S * P['neckLen']         # neck length
HL = S * P['headLen']         # head length
HH = S * P['headH']           # head height
TL = S * P['tailLen']         # tail length
LR = S * P['limbR']           # limb radius
FW = S * P['frontW']          # front stance half-width
HW = S * P['hindW']           # hind stance half-width
leg = S * 0.98                # front leg length (≈H)
knee = S * 0.55               # knee height above ground

if BIPED:
    # -- humanoid (biped) skeleton, head -Y, feet on ground --
    bones = [
        ('root',       (0, 0, 0.02*S),      (0, 0, 0.06*S),      None),
        ('hips',       (0, 0, 0.06*S),      (0, 0, 0.52*S),      'root'),
        ('spine',      (0, 0, 0.52*S),      (0, 0, 0.66*S),      'hips'),
        ('chest',      (0, 0, 0.66*S),      (0, 0, 0.76*S),      'spine'),
        ('neck',       (0, 0, 0.76*S),      (0, 0, 0.82*S),      'chest'),
        ('head',       (0, 0, 0.82*S),      (0, 0, 0.90*S),      'neck'),
    ]
    for side, sx in (('L', -1.0), ('R', 1.0)):
        bones += [
            (f'shoulder.{side}',  (sx*0.10*S, 0, 0.75*S), (sx*0.18*S, 0, 0.75*S), 'chest'),
            (f'upper_arm.{side}', (sx*0.18*S, 0, 0.75*S), (sx*0.24*S, 0, 0.62*S), f'shoulder.{side}'),
            (f'forearm.{side}',   (sx*0.24*S, 0, 0.62*S), (sx*0.24*S, 0, 0.48*S), f'upper_arm.{side}'),
            (f'hand.{side}',      (sx*0.24*S, 0, 0.48*S), (sx*0.24*S, 0, 0.44*S), f'forearm.{side}'),
            (f'thigh.{side}',     (sx*0.08*S, 0, 0.50*S), (sx*0.08*S, 0, 0.28*S), 'hips'),
            (f'shin.{side}',      (sx*0.08*S, 0, 0.28*S), (sx*0.08*S, 0, 0.06*S), f'thigh.{side}'),
            (f'foot.{side}',      (sx*0.08*S, 0, 0.06*S), (sx*0.03*S, 0.03*S, 0.02*S), f'shin.{side}'),
        ]
else:
    # -- quadruped skeleton: +Y = tail/rear, -Y = head/front; spine at shoulder height --
    hyp = H                                    # shoulder height
    tailY = 0.38 * L                          # rear end (pelvis)
    frontY = -0.36 * L                        # front end (shoulder)
    bones = [
        ('root',   (0, 0, 0.02*S),           (0, 0, 0.06*S),      None),
        ('pelvis', (0, tailY, hyp*0.99),     (0, tailY - 0.10*L, hyp*1.02), 'root'),
        ('spine1', (0, tailY - 0.16*L, hyp*1.03), (0, tailY - 0.30*L, hyp*1.05), 'pelvis'),
        ('spine2', (0, tailY - 0.40*L, hyp*1.06), (0, frontY + 0.10*L, hyp*1.05), 'spine1'),
        ('spine3', (0, frontY + 0.16*L, hyp*1.03), (0, frontY, hyp*1.02), 'spine2'),
        ('shoulder', (0, frontY, hyp*1.02),  (0, frontY - 0.05*L, hyp*1.02), 'spine3'),
        ('neck1',  (0, frontY - 0.05*L, hyp*1.02), (0, frontY - 0.05*L - 0.45*HN, hyp*1.16), 'shoulder'),
        ('neck2',  (0, frontY - 0.05*L - 0.45*HN, hyp*1.14), (0, frontY - 0.05*L - 0.95*HN, hyp*1.26), 'neck1'),
        ('head',   (0, frontY - 0.05*L - 0.95*HN, hyp*1.22), (0, frontY - 0.05*L - 0.95*HN - HL, hyp*1.28), 'neck2'),
    ]
    for side, sx in (('L', -1.0), ('R', 1.0)):
        bones += [
            (f'front_shoulder.{side}', (sx*FW, frontY, hyp*1.0),     (sx*FW, frontY, 0.45*S),          'shoulder'),
            (f'upper_front.{side}',    (sx*FW, frontY, 0.45*S),      (sx*FW, frontY, 0.12*S),          f'front_shoulder.{side}'),
            (f'lower_front.{side}',    (sx*FW, frontY, 0.12*S),      (sx*FW, frontY, 0.035*S),         f'upper_front.{side}'),
            (f'front_paw.{side}',      (sx*FW, frontY, 0.035*S),     (sx*FW*1.25, frontY, 0.015*S),    f'lower_front.{side}'),
            (f'hip.{side}',            (sx*HW, tailY, hyp*0.99),     (sx*HW, tailY, 0.45*S),           'pelvis'),
            (f'thigh.{side}',          (sx*HW, tailY, 0.45*S),       (sx*HW, tailY, 0.12*S),           f'hip.{side}'),
            (f'calf.{side}',           (sx*HW, tailY, 0.12*S),       (sx*HW, tailY, 0.035*S),          f'thigh.{side}'),
            (f'hind_paw.{side}',       (sx*HW, tailY, 0.035*S),      (sx*HW*1.25, tailY, 0.015*S),     f'calf.{side}'),
        ]
    # tail: from pelvis toward +Y, rising
    bones += [
        ('tail1', (0, tailY, hyp*1.05),       (0, tailY + 0.45*TL, hyp*1.14),  'pelvis'),
        ('tail2', (0, tailY + 0.45*TL, hyp*1.16), (0, tailY + 0.90*TL, hyp*1.24), 'tail1'),
        ('tail3', (0, tailY + 0.90*TL, hyp*1.26), (0, tailY + 1.30*TL, hyp*1.18), 'tail2'),
    ]

# ---- create armature ----
arm_data = bpy.data.armatures.new(RIG_NAME)
rig = bpy.data.objects.new(RIG_NAME, arm_data)
bpy.context.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='EDIT')
created = []
ed = {}
for name, head, tail, parent in bones:
    eb = arm_data.edit_bones.new(name)
    eb.head = Vector(head)
    eb.tail = Vector(tail)
    if RESET_ROLL:
        eb.roll = 0.0
    if parent:
        eb.parent = arm_data.edit_bones[parent]
    created.append(name)
    ed[name] = eb  # capture edit-bone refs INSIDE edit mode

# ---- block out body parts along the skeleton (data only; edit-mode refs) ----
def mid(a, b):
    a = Vector(a); b = Vector(b)
    return ((a[0]+b[0])/2, (a[1]+b[1])/2, (a[2]+b[2])/2)

parts = []  # (name, kind, geom, loc, tail, head, scale)
if BIPED:
    body_c = (0, 0, S*0.66)
    parts.append(('Torso', 'sph', S*0.26, body_c, None, None, (1.0, 0.75, 0.62)))
else:
    body_c = (0, 0.02*L, hyp*1.02)
    parts.append(('Torso', 'sph', BW*0.62, body_c, None, None, (1.0, 1.6, 0.62)))
    parts.append(('Chest', 'sph', BW*0.55, (0, frontY + 0.02*L, hyp*1.02), None, None, (1.0, 0.8, 1.0)))

def bone_parts(bone_name, radius, part_name):
    eb = ed[bone_name]
    # MUST copy to plain tuples in EDIT mode: after leaving edit mode the
    # EditBone head/tail memory can be freed/reordered, and lazy references
    # stored in parts would read garbage (observed: zero axes on Thigh.L+).
    _h = tuple(eb.head); _t = tuple(eb.tail)
    parts.append((part_name, 'cyl', radius, mid(_h, _t), _t, _h, None))

def bone_ball(bone_name, radius, part_name, offset=(0.0, 0.0, 0.0)):
    eb = ed[bone_name]
    _t = tuple(eb.tail)
    t = Vector(_t) + Vector(offset)
    parts.append((part_name, 'sph', radius, (t[0], t[1], t[2]), None, None, None))

def bone_cube(bone_name, sz, part_name, offset=(0.0, 0.0, 0.0)):
    eb = ed[bone_name]
    _t = tuple(eb.tail)
    t = Vector(_t) + Vector(offset)
    parts.append((part_name, 'cube', sz, (t[0], t[1], t[2]), None, None, None))

if BIPED:
    bone_ball('head', S*0.14, 'Head', (0, 0, S*0.02))
    bone_parts('neck', S*0.05, 'Neck')
    for side in ('L', 'R'):
        bone_parts(f'upper_arm.{side}', S*0.055, f'UpperArm.{side}')
        bone_parts(f'forearm.{side}', S*0.05, f'Forearm.{side}')
        bone_parts(f'thigh.{side}', S*0.085, f'Thigh.{side}')
        bone_parts(f'shin.{side}', S*0.07, f'Shin.{side}')
        bone_cube(f'foot.{side}', (S*0.11, S*0.20, S*0.02), f'Foot.{side}')
else:
    bone_ball('head', S*0.12*P['headH']/0.3, 'Head')
    bone_parts('neck1', S*0.06, 'Neck')
    for side in ('L', 'R'):
        bone_parts(f'upper_front.{side}', LR, f'UpperFront.{side}')
        bone_parts(f'lower_front.{side}', LR*0.78, f'LowerFront.{side}')
        bone_cube(f'front_paw.{side}', (LR*1.7, LR*1.3, S*0.02), f'FrontPaw.{side}')
        bone_parts(f'thigh.{side}', LR*1.05, f'Thigh.{side}')
        bone_parts(f'calf.{side}', LR*0.82, f'Calf.{side}')
        bone_cube(f'hind_paw.{side}', (LR*1.7, LR*1.3, S*0.02), f'HindPaw.{side}')
    # tail as tapering spheres along tail bones
    bone_ball('tail1', S*0.04, 'Tail1')
    bone_ball('tail2', S*0.028, 'Tail2')
    bone_ball('tail3', S*0.018, 'Tail3')
    # accessories
    acc = P['accessories']
    hl = ed['head']
    if acc == 'ears':
        for side, sx in (('L', -1.0), ('R', 1.0)):
            parts.append((f'Ear.{side}', 'sph', S*0.05, (sx*S*0.11, hl.tail[1] + S*0.03, hl.tail[2] + S*0.10), None, None, None))
    elif acc == 'horns':
        for side, sx in (('L', -1.0), ('R', 1.0)):
            parts.append((f'Horn.{side}', 'cyl', S*0.045, (sx*S*0.09, hl.tail[1] - S*0.02, hl.tail[2] + S*0.10), (sx*S*0.02, hl.tail[1] - S*0.10, hl.tail[2] + S*0.32), hl.tail, None))

# ---- build cylindrical parts with bmesh along the bone axis ----
import math as _math
import bmesh as _bmesh

def make_cyl(name, h_vec, t_vec, r, seg=16):
    """Cylinder spanning h_vec→t_vec. Avoids quaternion rotations entirely
    (rotation_difference is singular for anti-parallel axes, which produced
    NaN transforms for vertical limb bones)."""
    h_vec = Vector(h_vec); t_vec = Vector(t_vec)
    axis = t_vec - h_vec
    L = axis.length
    if L < 1e-6:
        return None
    dirv = axis / L
    ref = Vector((0, 0, 1))
    if abs(dirv.dot(ref)) > 0.9:
        ref = Vector((1, 0, 0))
    u = dirv.cross(ref).normalized()
    v = dirv.cross(u).normalized()
    bm = _bmesh.new()
    th = []; tt = []
    for i in range(seg):
        a = i / seg * _math.tau
        off = (_math.cos(a) * u + _math.sin(a) * v) * r
        th.append(bm.verts.new(h_vec + off))
        tt.append(bm.verts.new(t_vec + off))
    for i in range(seg):
        j = (i + 1) % seg
        bm.faces.new([th[i], tt[i], tt[j], th[j]])
    bm.faces.new(th)
    bm.faces.new(list(reversed(tt)))
    bm.normal_update()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    return o

bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.select_all(action='DESELECT')

# spawn parts
for (name, kind, geom, loc, tail, head, scale) in parts:
    loc = Vector(loc)
    if kind == 'sph':
        sph(name, geom, [loc[0], loc[1], loc[2]], scale)
    elif kind == 'cyl':
        if tail is not None and head is not None:
            make_cyl(name, head, tail, geom)
        else:
            cyl(name, geom, geom, [loc[0], loc[1], loc[2]])
    elif kind == 'cube':
        cube(name, geom, [loc[0], loc[1], loc[2]])

# merge all body parts into one mesh
me = bpy.data.objects.new('__merge_target', bpy.data.meshes.new('__merge'))
bpy.context.collection.objects.link(me)
bpy.ops.object.select_all(action='DESELECT')
for n in [p[0] for p in parts]:
    o = bpy.data.objects.get(n)
    if o is not None and o.type == 'MESH':
        o.select_set(True)
me.select_set(True)  # join requires the active object to be in the selection
bpy.context.view_layer.objects.active = me
bpy.ops.object.join()
me.name = MESH_NAME

# ---- bind ----
bind_status = 'skipped'
if DO_BIND:
    me.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    try:
        bpy.ops.object.parent_set(type='ARMATURE_AUTO')
        bind_status = 'ARMATURE_AUTO ok'
    except Exception as e:
        bind_status = f'auto weights failed: {e}'

# ---- summary ----
import json as _json
print(_json.dumps({'mesh': MESH_NAME, 'rig': RIG_NAME, 'bones': len(created), 'mode': 'biped' if BIPED else 'quadruped', 'preset': ${pystr(presetName)}, 'label': '${base.label}', 'bind': bind_status}, ensure_ascii=False))
print("DONE — verify visually with blender.get_viewport_screenshot")`;
  },
};

const TOOLS: BlenderTemplateTool[] = [
  RIG_HUMANOID,
  RIG_AUTO_WEIGHTS,
  ANIM_LOOP,
  QUAD_ANIM,
  MESH_PRIMITIVE,
  MESH_BOOLEAN,
  SCENE_EXPORT,
  BODY_BUILD,
];

const ADAPTER_PROPERTY = { type: 'string', description: '目标 Blender 适配器前缀，例如 blender 或 blender2；省略则使用配置中的第一个可用实例' };

export function getBlenderTemplateTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { ...t.inputSchema, properties: { ...(t.inputSchema.properties as Record<string, unknown> ?? {}), adapter: ADAPTER_PROPERTY } } }));
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
  const configured = (cfg.mcpServers ?? []).map((s) => s.toolsPrefix ?? s.name);
  const requested = typeof args.adapter === 'string' && args.adapter.trim() ? args.adapter.trim() : undefined;
  const prefixes = requested ? [requested] : configured;
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
    `${toolName}: no connected Blender adapter${requested ? ` for target '${requested}'` : ''} — checked prefixes: ${prefixes.join(', ') || '(none configured)'}`,
  );
}
