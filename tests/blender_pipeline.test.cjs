'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const files = ['blenderTemplateTools.ts', 'blenderAdvancedTools.ts'].map((name) => path.join(root, 'src', name)).filter(fs.existsSync);
const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
function requireFeature(label, ...patterns) { assert.ok(source, 'Blender source files must be present'); assert.ok(patterns.some((p) => p.test(source)), 'missing Blender feature: ' + label); }
test('export presets: Unity, Unreal, Godot', () => {
  requireFeature('Unity preset', /preset[^\n]{0,100}unity/i, /['\"]unity['\"]/i);
  requireFeature('Unreal preset', /preset[^\n]{0,100}unreal/i, /['\"]unreal['\"]/i);
  requireFeature('Godot preset', /preset[^\n]{0,100}godot/i, /['\"]godot['\"]/i);
});
test('rigging includes IK support', () => requireFeature('IK', /\bIK\b/i, /ik_constraint/i, /pose\.constraints/i));
test('materials include PBR maps', () => requireFeature('PBR maps', /PBR/i, /(?:albedo|base[_ -]?color|normal|roughness|metallic|ao)[^\n]{0,80}(?:map|texture|image)/i, /ShaderNodeTexImage/i));
test('pipeline includes baking', () => requireFeature('bake', /\bbake\b/i, /bpy\.ops\.object\.bake/i));
test('pipeline includes preview support', () => requireFeature('preview', /\bpreview\b/i, /get_viewport_screenshot/i, /render\.filepath/i));
test('animation includes loop creation and loop checks', () => {
  requireFeature('loop creation', /anim\.loop/i, /seamless loop/i, /looping/i);
  requireFeature('loop check', /loop[._ -]?check/i, /first\s*(?:and|\/)\s*last/i, /frame[_ ]?0/i);
});
