'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const load = name => import(pathToFileURL(path.join(root, 'dist', 'blender', name + '.js')).href);
async function payload() {
  const [compat, basic, advanced, exports] = await Promise.all([
    load('blenderActionCompat'), load('blenderTemplateTools'), load('blenderAdvancedTools'), load('blenderExportValidation'),
  ]);
  const tools = [...basic.getBlenderTemplateDefinitions(), ...advanced.getBlenderAdvancedTools(), ...exports.getBlenderExportValidationTools()];
  const code = (name, args = {}) => tools.find(t => t.name === name).buildCode(args);
  return {
    helper: compat.BLENDER_ACTION_COMPAT,
    list: code('blender.anim.list'),
    info: code('blender.anim.info', { action: 'CompatMulti' }),
    check: code('blender.anim.loop_check', { action: 'CompatMulti' }),
    fix: code('blender.anim.loop_fix', { action: 'CompatMulti' }),
    emptyCheck: code('blender.anim.loop_check', { action: 'CompatEmpty' }),
    emptyFix: code('blender.anim.loop_fix', { action: 'CompatEmpty' }),
    missingFix: code('blender.anim.loop_fix', { action: 'DoesNotExist' }),
    root: code('blender.anim.root_motion', { action: 'CompatMulti', rootBone: 'root' }),
    nla: code('blender.anim.nla_list', { rig: 'CompatRig' }),
    manifest: code('blender.export.manifest'),
    idle: code('blender.anim.loop', { rig: 'CompatRig', actionName: 'KeepExisting', motion: 'idle', frames: 8 }),
    walk: code('blender.anim.loop', { rig: 'CompatRig', actionName: 'KeepExisting', motion: 'walk', frames: 8 }),
    quad: code('blender.anim.quadruped', { rig: 'CompatRig', actionName: 'KeepExisting', frames: 8 }),
  };
}
test('all Action consumers embed the same compatibility helper', async () => {
  const p = await payload();
  for (const name of ['list', 'info', 'check', 'fix', 'root', 'manifest', 'idle', 'quad']) {
    assert.ok(p[name].includes(p.helper), name);
    assert.equal(p[name].split('def action_fcurves(').length - 1, 1, name);
  }
  assert.doesNotMatch(p.fix, /act\.update\(\)/);
  assert.match(p.fix, /fc.update()/);
  for (const name of ['list', 'info', 'fix', 'root', 'nla']) assert.doesNotMatch(p[name], /json\.dumps\(\{\}/);
  for (const name of ['idle', 'walk', 'quad']) assert.doesNotMatch(p[name], /bpy.data.actions.remove/);
  assert.equal(p.manifest.split('objs = sorted').length - 1, 1);
});
test('real Blender isolated factory-startup Action integration', { timeout: 120000 }, async t => {
  const blender = process.env.BLENDER_EXECUTABLE || 'H:/Program Files/blender-5.2.0-windows-x64/blender.exe';
  if (!fs.existsSync(blender)) {
    if (process.env.BLENDER_REQUIRED === '1') assert.fail('Blender executable not found: ' + blender);
    return t.skip('Blender unavailable; set BLENDER_EXECUTABLE to run real integration: ' + blender);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blender-action-compat-'));
  try {
    const input = path.join(dir, 'generated-tools.json');
    fs.writeFileSync(input, JSON.stringify(await payload()), 'utf8');
    const fixture = path.join(__dirname, 'fixtures', 'blender_action_compat.py');
    if (!fs.existsSync(fixture)) return t.skip('Blender fixture unavailable: ' + fixture);
    const args = ['--background', '--factory-startup', '--python-exit-code', '1', '--python', fixture, '--', input];
    t.diagnostic('Isolated Blender: ' + blender + ' ' + args.join(' '));
    const run = spawnSync(blender, args, { stdio: 'inherit', timeout: 110000, windowsHide: true });
    assert.ifError(run.error);
    assert.equal(run.status, 0, 'Blender Python assertions must pass');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});