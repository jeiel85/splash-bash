import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    // 실제 맵 GLB 로드 + 봇 시뮬레이션 준비가 부하 시 10초를 넘을 수 있다
    hookTimeout: 60000,
  },
});
