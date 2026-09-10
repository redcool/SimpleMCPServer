// Inspect the axis settings + geometry bbox of an exported FBX file.
// Usage: node scripts/peek-fbx-axes.mjs [path-to.fbx]
// Default: C:/tmp/dog_walk_axes.fbx
// Verifies what Blender's FBX export actually wrote (see docs/blender-mcp-template-tools.md
// "FBX 前向轴" section): GlobalSettings axes + mesh vertex bounding box, so you can confirm
// whether geometry was axis-swapped at export time or only declared in metadata.
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2] ?? 'C:/tmp/dog_walk_axes.fbx';
const buf = fs.readFileSync(file);
const s = buf.toString('latin1');

// --- GlobalSettings (text labels, binary int32 values) ---
function intAfter(label) {
  const i = s.indexOf(label);
  if (i < 0) return null;
  // After <label>: 'S' len(4) "int", 'S' len(4) "Integer", 'S' len(4) "", 'I' int32
  let p = i + label.length;
  const skipStr = () => { p += 5 + buf.readUInt32LE(p + 1); }; // 'S'+len+data
  skipStr(); skipStr(); skipStr();
  if (buf[p] !== 0x49) return null;
  return buf.readInt32LE(p + 1);
}
const up = intAfter('UpAxis');
const upSign = intAfter('UpAxisSign');
const front = intAfter('FrontAxis');
const frontSign = intAfter('FrontAxisSign');
const AXIS = ['X', 'Y', 'Z'];
console.log('GlobalSettings: UpAxis=' + AXIS[up] + (upSign < 0 ? '-' : '+') +
  '  FrontAxis=' + AXIS[front] + (frontSign < 0 ? '-' : '+') +
  '  (Blender export axis_forward=-Y, axis_up=Z → UpAxis=Z+ FrontAxis=Y+)');

// --- first mesh's vertices bbox ---
const vi = s.indexOf('Vertices');
if (vi >= 0) {
  const arrLen = buf.readUInt32LE(vi + 9);
  const enc = buf.readUInt32LE(vi + 13);
  const clen = buf.readUInt32LE(vi + 17);
  const dataStart = vi + 21;
  const raw = enc === 1
    ? zlib.inflateSync(buf.subarray(dataStart, dataStart + clen))
    : buf.subarray(dataStart, dataStart + arrLen * 8);
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let v = 0; v < arrLen / 3; v++) {
    for (let c = 0; c < 3; c++) {
      const val = raw.readDoubleLE(v * 24 + c * 8);
      if (val < mn[c]) mn[c] = val;
      if (val > mx[c]) mx[c] = val;
    }
  }
  console.log('Mesh verts bbox: min [' + mn.map(v => v.toFixed(3)) + ']  max [' + mx.map(v => v.toFixed(3)) + ']');
  console.log('  (compare with the Blender scene bbox; identical numbers = geometry not axis-swapped)');
} else {
  console.log('no mesh Vertices found');
}
console.log('size MB:', (buf.length / 1048576).toFixed(2), ' models:', (s.match(/Model::/g) ?? []).length);