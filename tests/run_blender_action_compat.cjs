// Dedicated real-Blender runner; unlike npm test, absence of Blender is a failure.
// Usage: node tests/run_blender_action_compat.cjs
// Optional: set BLENDER_EXECUTABLE to another Blender executable.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const args of [
  [path.join(root, 'node_modules/typescript/bin/tsc')],
  ['--test', path.join(__dirname, 'blender_action_compat.test.cjs')],
]) {
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit', env: { ...process.env, BLENDER_REQUIRED: '1' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
