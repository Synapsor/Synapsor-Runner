import fs from 'node:fs';
import path from 'node:path';
const plan = JSON.parse(fs.readFileSync(new URL('./assignment-plan.json', import.meta.url)));
export default { plugins: [{ name: 'historical-checkpoint-guard-replay', enforce: 'pre',
 load(id) { if (id === path.resolve('apps/runner/src/boundary-authoring-resume.ts')) return fs.readFileSync(path.join(plan.owned_root, 'prompt-before/boundary-authoring-resume-replay.ts'), 'utf8'); } }],
 test: { include: ['apps/runner/src/boundary-cli.test.ts'], maxWorkers: 1, minWorkers: 1 } };
