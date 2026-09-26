/** 타입 안전한 최소 이벤트 에미터. */
export class Emitter<Events extends { [K in keyof Events]: (...args: never[]) => void }> {
  private handlers = new Map<keyof Events, Set<Events[keyof Events]>>();

  on<K extends keyof Events>(type: K, fn: Events[K]): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  emit<K extends keyof Events>(type: K, ...args: Parameters<Events[K]>): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) (fn as (...a: Parameters<Events[K]>) => void)(...args);
  }

  clear(): void {
    this.handlers.clear();
  }
}
