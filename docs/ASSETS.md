# 에셋 규약 (Asset Contract)

모든 3D 에셋은 `tools/blender/*.py` 스크립트로 **코드에서 생성**한다(수작업 .blend 없음 → 재현 가능).
런타임(Three.js)은 이 문서의 노드 이름·머티리얼 이름·앵커 규약에만 의존한다. 규약을 바꾸면 이 문서를 먼저 고친다.

## 도구

- Blender 4.5 LTS (포터블): `D:\Tools\blender-4.5.10-windows-x64\blender.exe`
  - 경로는 환경변수 `BLENDER` 로 덮어쓸 수 있다(`tools/build-assets.mjs`).
- 실행: `blender -b --factory-startup --python tools/blender/<script>.py -- --out public/assets/models/<name>.glb [--preview tools/blender/previews/<name>.png]`
- 전체 재생성: `npm run assets`

## 공통 규칙

| 항목 | 규칙 |
| --- | --- |
| 단위 | 1 Blender unit = 1 m |
| 축 | Blender Z-up 에서 모델링 → glTF 내보내기 `export_yup=True` (런타임 Y-up) |
| 정면 | 캐릭터·총의 정면은 Blender **-Y** (glTF/Three.js 에서 **+Z**) |
| 형태 | "각지지 않게": 모든 메시는 Subdivision Surface(레벨 2 이상) 또는 Bevel(세그먼트 3+) 적용 후 내보내기. Smooth shading. 날카로운 90° 모서리 금지 |
| 머티리얼 | Principled BSDF 의 Base Color 만 의미 있음(런타임이 툰 머티리얼로 변환). 텍스처 없음 |
| 모디파이어/트랜스폼 | 내보내기 전 모두 적용(`export_apply=True`), 스케일 1 |
| 내보내기 | `export_format='GLB'`, `export_extras=True`, `export_animations=False`, 카메라·라이트 제외 |
| 폴리 예산 | 캐릭터 ≤ 6k tris, 총 1정 ≤ 3k, 모자 1개 ≤ 1.5k, 맵 전체 ≤ 150k |

### 특수 머티리얼 이름 (런타임이 이름으로 식별)

| 이름 | 런타임 처리 |
| --- | --- |
| `Tint` | 플레이어 색으로 교체 |
| `TintDark` | 플레이어 색을 어둡게(×0.72) |
| `TintLight` | 플레이어 색을 밝게(흰색 쪽 35% 보간) |
| `Water` | 반투명 물 머티리얼(탱크 속 물, 수영장 수면) |
| `Eye` / `Pupil` / `EyeShine` | 눈 흰자 / 눈동자 / 하이라이트(외곽선·그림자 제외) |
| `Invisible` | 렌더링하지 않음(충돌 전용 헬퍼) |
| 그 외 | Base Color 그대로 툰 셰이딩 |

## 공통 팔레트 (hex)

- 하늘: 위 `#6EC6FF`, 지평선 `#D4F1FF`
- 잔디 `#8BD66B` / 어두운 잔디 `#5DB85A`
- 물 `#4FD1E8` / 깊은 물 `#2BA6D9`
- 나무 `#E8B07A` / 어두운 나무 `#C98B55`
- 흰 펜스 `#FFF6E8`, 모래 `#F6DDA4`
- 포인트: 코랄 `#FF7B7B`, 햇살 노랑 `#FFD35C`, 민트 `#7EE0C3`, 라벤더 `#B9A6FF`, 핑크 `#FF9CCB`, 오렌지 `#FFA552`
- 외곽선: `#2B2D42`
- 플레이어 색(8): `#FF8A1F` `#7B5CFF` `#FF4F8B` `#19C3A6` `#FFD23F` `#3D8BFF` `#A0E426` `#FF6F7D` (`src/config.ts` PLAYER_COLORS 가 기준)
- 팀 색: 탠저린 `#FF8A1F`, 그레이프 `#7B5CFF` (파란색은 물·하늘과 겹쳐 팀 색으로 쓰지 않음)

## 파일별 규약

### `character.glb`
- 루트 노드 `Character`. 원점 = 발바닥 중앙(y=0), 전체 높이 ≈ 1.6 m, 폭 ≈ 0.8 m (충돌 캡슐 반지름 0.4 m 와 일치).
- 메시(각각 별도 오브젝트, 런타임이 절차적 애니메이션으로 움직임):
  - `Body` — 콩/달걀형 몸통(머리와 몸 일체형, 귀여운 비율). 머티리얼 `Tint` (배 부분은 `TintLight` 가능)
  - `EyeL`, `EyeR` — 크고 동그란 눈 (`Eye` + `Pupil` + `EyeShine`)
  - `Cheeks` — 볼터치(분홍 `#FF9CCB`), 선택
  - `HandL`, `HandR` — 몸에서 떨어진 둥근 장갑 손(레이맨식), `TintDark` 또는 흰색. 원점 = 손 중심
  - `FootL`, `FootR` — 타원형 발, `TintDark`. 원점 = 발 중심
- Empty 앵커:
  - `HatAnchor` — 정수리(모자 부착 지점)
  - `GunAnchor` — 오른손 위치, 총이 정면(+Z)을 향하도록
  - `NameAnchor` — 머리 위 ≈ 2.0 m (닉네임 표시)

### `hats.glb`
- 노드: `hat_cap`, `hat_duck`, `hat_flower`, `hat_crown`, `hat_frog`, `hat_bucket` (6종 이상)
- 각 노드 원점 = 모자 바닥 중앙(`HatAnchor` 에 그대로 붙임). 크기는 `character.glb` 머리에 맞춤.

### `weapons.glb`
- 노드: `gun_pistol`(물총 권총), `gun_soaker`(대형 펌프식 슈퍼 물총), `gun_bucket`(양동이 블래스터 — 산탄형), `balloon`(물풍선)
- 각 총: 원점 = 손잡이(쥐는 점), 정면 +Z. 자식 Empty `Muzzle` = 노즐 끝. 물탱크 메시는 머티리얼 `Water`, 이름 `Tank` 를 포함하도록(`gun_soaker_Tank` 처럼 접두 허용).
- 장난감 플라스틱 느낌: 선명한 주황·노랑·청록·분홍 조합.
- `balloon`: 원점 = 중심, 지름 ≈ 0.22 m, 묶인 꼭지 포함.

### `map_backyard.glb`
- 루트 노드 `Map`. 플레이 영역 ≈ 50 × 50 m, 바깥은 장식.
- 충돌: 기본적으로 **모든 메시가 충돌**한다. 예외:
  - 이름이 `nocol_` 로 시작 → 충돌 없음(풀, 꽃, 구름 등)
  - 이름이 `water_` 로 시작 → 충돌 없음, 수면(물 채우기 구역 판정용)
  - 이름이 `col_` 로 시작 + 머티리얼 `Invisible` → 보이지 않는 충돌 헬퍼(경계벽, 계단 대신 경사로 등)
- Empty 마커(custom property → glTF extras):
  - `spawn_XX` — 스폰 지점. extras `team`: -1(공용)/0/1. 회전(Z축) = 바라보는 방향
  - `fountain_XX` — 물 보충 분수. extras `radius`(m)
  - `jumppad_XX` — 점프대(트램펄린) 윗면 중심. extras `target`: 착지 목표 Empty 이름(예 `jumptarget_01`) — 런타임이 최고점 = 목표 높이 + 1 m 가 되도록 탄도를 풀어 발사. `radius`(기본 1.1)
  - `jumptarget_XX` — 점프대 착지 목표(전망대 바닥 위 등)
  - `wp_XX` — 봇 웨이포인트. extras `links`: `"wp_03,wp_07"` (양방향 간선)
  - `balloon_XX` — 물풍선 보급 상자 위치
  - `bounds` — extras `minX,maxX,minZ,maxZ,killY`

### 레벨 치수(캐릭터 물리 기준)

- 캡슐 반지름 0.4 m, 키 1.6 m, 점프 최고 1.2 m → 0.9~1.0 m 는 점프로 오를 수 있고, 1.6 m 이상은 못 넘는다.
- **계단은 오를 수 없다**(캡슐이 모서리에 걸림). 걸어서 오르내리는 높이 차는 **경사 ≤ 35° 램프**로 만든다.
  시각적 계단이 필요하면 계단 위에 `col_` + `Invisible` 경사로를 겹쳐 둔다.
- 바닥으로 인정되는 경사: 법선 y ≥ 0.64 (≈ 50°).
- 드로우콜: 정적 메시는 머티리얼별로 합쳐 맵 전체 250 이하. 충돌 이름 규칙(`nocol_`, `water_`, `col_`)을 지키며 합칠 것.
- 검증: `npx vitest run tests/map.test.ts` (스폰 안착, 점프대 착지, 웨이포인트 연결, 경계).

## 미리보기

에셋 스크립트는 `--preview` 인자가 있으면 Workbench/EEVEE 로 PNG 미리보기를 렌더한다(`tools/blender/previews/`, git 제외).
최종 확인은 게임과 같은 툰 파이프라인을 쓰는 `dev/viewer.html` 에서 한다.
