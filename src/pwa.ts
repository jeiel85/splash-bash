import { isEmbedded } from './ui/profile';

/**
 * 설치형 PWA 서비스워커(public/sw.js) 등록.
 * Input: 없음(환경은 import.meta.env·navigator·window 에서 읽음)
 * Output: 없음 — 등록은 load 이후 백그라운드로 하고, 실패는 경고만 남긴다(게임 진행에는 영향 없음)
 * 왜: - 개발 서버(vite dev)에서는 SW 가 모듈을 캐시해 수정이 안 보이게 만들 수 있어 배포 빌드에서만 등록한다.
 *     - iframe(itch.io 임베드) 안에서는 그 호스트의 경로에 SW 를 남기지 않도록 등록하지 않는다.
 *     - 경로는 BASE_URL('./') 기준이라 GitHub Pages 의 /splash-bash/ 아래로만 범위가 잡힌다.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || isEmbedded()) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => {
        const worker = registration.active;
        if (!worker) return;
        // 첫 방문처럼 SW가 제어하기 전에 받은 같은 출처 자산(workerStart 0)을 SW에 알려
        // 오프라인용으로 캐시하게 한다. SW를 거친 요청은 SW가 이미 캐시한다.
        worker.postMessage({ type: 'CACHE_URLS', urls: [location.href] });
        new PerformanceObserver((list) => {
          const urls = list.getEntries()
            .filter((entry) => (entry as PerformanceResourceTiming).workerStart === 0)
            .map((entry) => entry.name);
          if (urls.length) worker.postMessage({ type: 'CACHE_URLS', urls });
        }).observe({ type: 'resource', buffered: true });
      })
      .catch((error: unknown) => {
        console.warn('[pwa] 서비스워커 등록 실패(게임에는 영향 없음)', error);
      });
  });
}
