/**
 * 모든 3D 에셋을 Blender 스크립트로 재생성한다.
 *   npm run assets            (전체)
 *   npm run assets -- weapons (이름 지정)
 * Blender 경로: 환경변수 BLENDER, 없으면 D:/Tools/blender-4.5.10-windows-x64/blender.exe
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const BLENDER = process.env.BLENDER ?? 'D:/Tools/blender-4.5.10-windows-x64/blender.exe';
const ASSETS = [
  { script: 'character', out: 'character.glb' },
  { script: 'hats', out: 'hats.glb' },
  { script: 'weapons', out: 'weapons.glb' },
  { script: 'map_backyard', out: 'map_backyard.glb' },
];

if (!existsSync(BLENDER)) {
  console.error(`Blender 를 찾을 수 없습니다: ${BLENDER}\n환경변수 BLENDER 로 경로를 지정하세요 (Blender 4.5 LTS).`);
  process.exit(1);
}

const only = process.argv.slice(2);
const targets = only.length ? ASSETS.filter((a) => only.includes(a.script)) : ASSETS;
let failed = 0;
for (const a of targets) {
  const script = `tools/blender/${a.script}.py`;
  if (!existsSync(script)) {
    console.error(`[skip] ${script} 없음`);
    failed++;
    continue;
  }
  console.log(`[build] ${a.out}`);
  const r = spawnSync(BLENDER, ['-b', '--factory-startup', '--python', script, '--', '--out', `public/assets/models/${a.out}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  const log = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const ok = r.status === 0 && !/Traceback|Error:/.test(log);
  if (!ok) {
    failed++;
    console.error(log.split('\n').slice(-30).join('\n'));
    console.error(`[fail] ${a.out}`);
  } else {
    const line = log.split('\n').find((l) => l.startsWith('[export]'));
    console.log(`  ${line ?? 'ok'}`);
  }
}
process.exit(failed ? 1 : 0);
