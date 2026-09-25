import { describe, expect, it } from 'vitest';
import { SIGNALING_RELAYS } from '../src/net/transport';

describe('시그널링 릴레이 목록(QA P2-3)', () => {
  it('검증한 wss 릴레이를 4곳 이상, 겹치지 않게 명시한다', () => {
    expect(SIGNALING_RELAYS.length).toBeGreaterThanOrEqual(4);
    expect(new Set(SIGNALING_RELAYS).size).toBe(SIGNALING_RELAYS.length);
    for (const url of SIGNALING_RELAYS) expect(url).toMatch(/^wss:\/\/[a-z0-9.-]+(\/[\w/-]*)?$/);
  });

  it('임시 이벤트를 거부하는 릴레이·스테이징·시험용 서버는 넣지 않는다', () => {
    for (const url of SIGNALING_RELAYS) {
      expect(url).not.toMatch(/relay-rpi\.edufeed\.org|staging\.|testrelay/);
    }
  });
});
