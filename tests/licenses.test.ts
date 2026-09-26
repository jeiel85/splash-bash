import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8').replace(/\r\n/g, '\n');

describe('제3자 라이선스 고지(public/third-party-licenses.txt — 배포 빌드에 함께 실린다)', () => {
  const text = read('public/third-party-licenses.txt');

  it('package.json 런타임 의존성이 설치된 버전 그대로 모두 실려 있다(바꾸면 node tools/licenses.mjs 로 다시 만든다)', () => {
    const deps = Object.keys((JSON.parse(read('package.json')) as { dependencies: Record<string, string> }).dependencies);
    expect(deps.length).toBeGreaterThan(0);
    for (const d of deps) {
      const v = (JSON.parse(read(`node_modules/${d}/package.json`)) as { version: string }).version;
      expect(text, `${d}@${v} 고지 없음`).toContain(`\n${d} ${v}\n`);
    }
  });

  it('MIT 허가 문구와 Jua 폰트 OFL 전문을 싣는다', () => {
    expect(text).toContain('Permission is hereby granted, free of charge');
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it('메인 메뉴의 "크레딧·라이선스" 링크가 이 파일을 가리킨다(base ./ 기준 상대 경로)', () => {
    expect(read('src/ui/menu.ts')).toContain("credits.href = 'third-party-licenses.txt'");
  });
});
