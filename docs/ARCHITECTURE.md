# 아키텍처

브라우저 단일 페이지 게임. 빌드 결과는 정적 파일뿐이며 운영 서버가 없다.

```
index.html → src/main.ts (부팅·메뉴·방 참가·메인 루프)
                 │
                 ├─ render/   RenderContext(렌더러·조명·하늘·1인칭 별도 패스·자동 품질), toon(툰 셰이딩·화면 픽셀 외곽선·림 라이트·물),
                 │            assets(GLB 로드·인스턴스), fx(물방울·고리·젖은 자국·색종이, 인스턴싱), billboard(이름표·젖음 막대)
                 ├─ world/    map(GLB → 충돌·마커), collision(three-mesh-bvh 캡슐·레이), testArena(시험장)
                 ├─ game/     Game(한 판의 오케스트레이터)
                 │              ├ PlayerBody(캡슐 물리) · Arsenal(탱크·발사) · Vitality(젖음·부활)
                 │              ├ ProjectileSystem(물방울·물풍선, 쏜 사람 판정)
                 │              ├ RemoteActor(보간) · BotActor + BotBrain(호스트 전용 AI)
                 │              ├ MatchHost(호스트: 시간·점수·팀) / MatchView(클라이언트)
                 │              └ Avatar(3인칭 캐릭터) · ViewModel(1인칭 무기)
                 ├─ net/      Transport(Trystero P2P / Offline) → Session(hello·호스트 선출·검증) · protocol(인코딩·검증) · interp(보간·시계)
                 ├─ ui/       Menu · PauseMenu · Hud · MenuStage · icons(SVG) · profile(localStorage 설정) · visitCounter(방문자 수)
                 └─ audio/    Sfx(WebAudio 합성 효과음·먹먹함) · music(생성형 배경음악·앰비언스)
```

## 한 프레임

1. `Input.sample()` → `Intent` (봇은 `BotBrain.think()` 가 같은 `Intent` 를 만든다)
2. 로컬 `PlayerBody.step` → `Arsenal.tick` → 발사 요청 → `ProjectileSystem.fire*` + 네트워크 발사 이벤트 대기열
3. 호스트면 봇 시뮬레이션
4. 원격 플레이어: `SnapshotBuffer.sample(now − 110ms)` → `Avatar.update`
5. 투사체·효과 갱신 → 권한 있는 명중은 `onAuthoritativeHit` → 로컬 적용 또는 `hit` 전송
6. 20Hz 네트워크 틱: 상태·봇 상태·발사·명중 전송, 호스트는 1Hz 경기 상태
7. 카메라·HUD·효과음 리스너

## 권한(누가 무엇을 결정하나)

| 대상 | 권한자 |
|---|---|
| 내 이동·탱크·젖음·쓰러짐 | 나 |
| 명중 판정 | 쏜 사람(봇이면 호스트) |
| 봇 전체 | 호스트 |
| 경기 시간·점수·팀 | 호스트 |
| 호스트 | (joinedAt, id) 가 가장 작은 사람 — 모두 같은 규칙으로 계산 |

수신 메시지는 `protocol.ts` 에서 형식·범위를 검증하고, `Session` 에서 보낸 사람 권한을 검증한다(남의 상태·쓰러짐을 대신 보낼 수 없음, 봇 관련은 호스트만).

## 방 참가·정원·합치기

- 빠른 대전은 `quick-1` 부터 차례로 본다. 참가 후 첫 피어가 오면 1.5초 더 모으고, 아무도 없으면 6초 뒤 혼자 시작한다(봇이 채움). 코드 참가는 최대 10초, 방 만들기는 기다리지 않는다(`NET.discover`).
- 탐색은 일부만 보고 판단하므로 입장 뒤에도 정원을 확인한다: 사람이 8명을 넘으면 (joinedAt, id) 순서로 가장 늦게 온 사람이 나간다(빠른 대전은 다음 방으로).
- 따로 시작한 두 무리가 뒤늦게 연결되면(두 호스트) 선출 규칙으로 한쪽이 호스트가 되고, 진 쪽은 자기 봇을 버리고 이긴 쪽 경기 상태·봇을 받는다. 봇 id 는 `bot-<호스트 id 앞 4자>-N` 이라 겹치지 않는다.
- 3초 넘게 아무 메시지도 없는 피어는(탭 강제 종료 등, 전송 계층의 떠남 통지는 7~10초 걸림) 화면·명중 대상·봇 인식에서 뺐다가 다시 말하면 되돌린다. 호스트였다면 그 사이 다음 사람이 호스트를 이어받는다.

## 메시지(Trystero action)

| 이름 | 방향 | 내용 |
|---|---|---|
| `hello` | 모두 ↔ 모두 | 프로토콜 버전, 닉네임·꾸미기·참가 시각 |
| `st` | 모두 → 모두, 20Hz | 내 스냅샷(위치·속도·시선·무기·젖음·탱크·플래그) |
| `bots` / `binfo` | 호스트 → 모두 | 봇 스냅샷 20Hz / 봇 목록 |
| `fire` | 쏜 사람 → 모두 | 발사(시드·퍼짐·원점·방향) — 모두가 같은 물방울을 재현 |
| `hit` | 쏜 사람 → 모두 | 명중(피해자 권한자만 적용) |
| `splash` | 피해자 권한자 → 모두 | 쓰러짐(킬피드·점수) |
| `match` | 호스트 → 모두, 1Hz + 변경 시 | 경기 상태 |

## 개발 도구

- `npm run dev` — 개발 서버(127.0.0.1:5317). `?map=test` 시험장, `?bots=0` 봇 없음, `?autoquality=0` 자동 품질 끔, DEV 빌드는 `window.__splash`·`window.__render` 디버그 API(프로덕션 빌드에는 없음)와 `?pause=0`(포인터 잠금이 풀려도 연습 모드를 멈추지 않음 — 자동화 스크린샷용)
- `npm run test:e2e` — 실제 Trystero·공개 Nostr 릴레이로 여러 브라우저를 띄워 연결·동기화·명중·호스트 이전·두 호스트 합치기·팀전을 검증(자체 Vite 서버 5319 를 띄움, 인터넷 필요)
- `npm test` — 단위·규약·맵 검증 테스트, `npm run typecheck`
- `npm run assets` — Blender 로 모든 GLB 재생성 (`docs/ASSETS.md`)
- `node tools/screenshot.mjs`, `node tools/ingame-shot.mjs` — 에셋/인게임 스크린샷
- `node tools/check-relays.mjs [--candidates] [--rounds N]` — 시그널링 릴레이 실측(릴레이 하나만 쓰는 두 브라우저가 연결·메시지 왕복). 목록은 `src/net/transport.ts` 의 `SIGNALING_RELAYS`(인터넷 필요)
