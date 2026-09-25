# 아키텍처

브라우저 단일 페이지 게임. 빌드 결과는 정적 파일뿐이며 운영 서버가 없다.

```
index.html → src/main.ts (부팅·메뉴·방 참가·메인 루프)
                 │
                 ├─ render/   RenderContext(렌더러·조명·하늘), toon(툰 변환·외곽선), assets(GLB 로드·인스턴스), fx(파티클·데칼)
                 ├─ world/    map(GLB → 충돌·마커), collision(three-mesh-bvh 캡슐·레이), testArena(시험장)
                 ├─ game/     Game(한 판의 오케스트레이터)
                 │              ├ PlayerBody(캡슐 물리) · Arsenal(탱크·발사) · Vitality(젖음·부활)
                 │              ├ ProjectileSystem(물방울·물풍선, 쏜 사람 판정)
                 │              ├ RemoteActor(보간) · BotActor + BotBrain(호스트 전용 AI)
                 │              ├ MatchHost(호스트: 시간·점수·팀) / MatchView(클라이언트)
                 │              └ Avatar(3인칭 캐릭터) · ViewModel(1인칭 무기)
                 ├─ net/      Transport(Trystero P2P / Offline) → Session(hello·호스트 선출·검증) · protocol(인코딩·검증) · interp(보간·시계)
                 ├─ ui/       Menu · PauseMenu · Hud · MenuStage · profile(localStorage 설정)
                 └─ audio/    Sfx(WebAudio 합성 효과음)
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

- `npm run dev` — 개발 서버(127.0.0.1:5317). `?map=test` 시험장, `?bots=0` 봇 없음, DEV 빌드는 `window.__splash` 디버그 API
- `npm test` — 단위·규약·맵 검증 테스트, `npm run typecheck`
- `npm run assets` — Blender 로 모든 GLB 재생성 (`docs/ASSETS.md`)
- `node tools/screenshot.mjs`, `node tools/ingame-shot.mjs` — 에셋/인게임 스크린샷
