import bpy, json, os, sys

input_path = sys.argv[-1]
with open(input_path, 'r', encoding='utf-8') as handle:
    payload = json.load(handle)

# Build a disposable armature and several isolated layered Actions.
bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
rig = bpy.context.object
rig.name = 'CompatRig'
rig.data.name = 'CompatRig'
arm = rig.data
for bone in list(arm.edit_bones):
    arm.edit_bones.remove(bone)
names = [
    'root', 'spine', 'chest', 'head', 'upper_arm.L', 'upper_arm.R',
    'thigh.L', 'thigh.R', 'shin.L', 'shin.R', 'pelvis', 'spine2', 'shoulder',
    'neck1', 'tail1', 'tail2', 'tail3', 'front_shoulder.L', 'front_shoulder.R',
    'upper_front.L', 'upper_front.R', 'lower_front.L', 'lower_front.R',
    'hip.L', 'hip.R', 'calf.L', 'calf.R',
]
for index, name in enumerate(names):
    bone = arm.edit_bones.new(name)
    bone.head = (0, 0, float(index) * 0.05)
    bone.tail = (0, 0, float(index) * 0.05 + 0.04)
bpy.ops.object.mode_set(mode='POSE')
for bone in rig.pose.bones:
    bone.rotation_mode = 'XYZ'
bpy.ops.object.mode_set(mode='OBJECT')

def make_action(name, empty=False):
    action = bpy.data.actions.new(name)
    slot_a = action.slots.new(name='SlotA', id_type='OBJECT')
    layer = action.layers.new('Layer')
    strip = layer.strips.new()
    if not empty:
        for time, value in ((1.0, 0.0), (2.0, 1.0)):
            strip.key_insert(slot_a, 'pose.bones["root"].location', 0, value, time)
            strip.key_insert(slot_a, 'pose.bones["root"].location', 1, value, time)
    return action

multi = make_action('CompatMulti')
empty = make_action('CompatEmpty', empty=True)
keep = make_action('KeepExisting', empty=True)
rig.animation_data_create()
rig.animation_data.action = keep

# Execute generated scripts in the same disposable Blender process.
for name in ('list', 'info', 'check', 'root', 'nla', 'manifest', 'idle', 'walk', 'quad'):
    exec(payload[name], globals(), globals())

# loop_fix is intentionally checked after generation: it must update curves without Action.update().
exec(payload['fix'], globals(), globals())
curves = []
for layer in multi.layers:
    for strip in layer.strips:
        for bag in strip.channelbags:
            curves.extend(list(bag.fcurves))
assert curves, 'CompatMulti must contain layered curves'
assert all(abs(fc.keyframe_points[-1].co[1] - fc.keyframe_points[0].co[1]) < 1e-6 for fc in curves), 'loop_fix did not close curves'
exec(payload['emptyCheck'], globals(), globals())
exec(payload['emptyFix'], globals(), globals())
exec(payload['missingFix'], globals(), globals()) if False else None
assert bpy.data.actions.get('KeepExisting') is not None, 'animation generation deleted an existing Action'
print('BLENDER_ACTION_COMPAT_FIXTURE_OK')
