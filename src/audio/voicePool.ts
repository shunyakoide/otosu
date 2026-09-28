// 声部の置き場と、次に鳴らす声部の選び方（D40）。Tone を import しない純 TS（テストできるように）。

/** 声部の共通部分（発音の開始時刻と鳴り終わる時刻） */
export type Slot = {
  /** 最後に発音を始めた時刻。一番古い声部を選ぶのに使う */
  startedAt: number;
  /** リリースまで鳴り終わる時刻 */
  endsAt: number;
};

/**
 * 声部の置き場。声部（シンセとノード一式）は最初にまとめて作らず、足りなくなったときに max まで作る。
 * 始めた瞬間に数百のノードを作るとモバイルでメモリが跳ねてページが落ちるため（D40）
 */
export type Pool<V extends Slot> = { readonly items: V[]; readonly max: number; readonly make: () => V };

/** 同じ声部を同時刻に再発音すると Tone が例外を投げるので、それより確実に後の時刻だけを使う */
export const RETRIGGER_EPS = 1e-4;

export function makePool<V extends Slot>(max: number, make: () => V): Pool<V> {
  return { items: [], max, make };
}

/** 音の仕組みを作る前の置き場（声部を作れない） */
export function emptyPool<V extends Slot>(): Pool<V> {
  return makePool(0, () => {
    throw new Error('not started');
  });
}

/** まだ一度も鳴らしていない声部の時刻 */
export function idleSlot(): Slot {
  return { startedAt: -Infinity, endsAt: -Infinity };
}

/** 声部を at から鳴らしたことにする。鳴り終わるのは at + dur + release */
export function occupy(v: Slot, at: number, dur: number, release: number): void {
  v.startedAt = at;
  v.endsAt = at + dur + release;
}

/**
 * 鳴り終わった声部があればその中で一番古いもの、なければ一番古く発音を始めた声部を止めて使う。
 * どの声部も at と同時刻（以降）に発音済みなら undefined（その音は捨てる）
 */
export function pickSlot<V extends Slot>(pool: Pool<V>, at: number): V | undefined {
  return freeSlot(pool, at) ?? oldestSlot(pool.items, at);
}

/** 空いている声部。なければ上限まで新しく作る */
export function freeSlot<V extends Slot>(pool: Pool<V>, at: number): V | undefined {
  let free: V | undefined;
  for (const v of pool.items) {
    if (v.endsAt <= at && v.startedAt < at - RETRIGGER_EPS && (!free || v.startedAt < free.startedAt)) free = v;
  }
  if (free || pool.items.length >= pool.max) return free;
  const made = pool.make();
  pool.items.push(made);
  return made;
}

/** 一番古く発音を始めた声部（at と同時刻以降に発音済みのものは除く） */
export function oldestSlot<V extends Slot>(pool: readonly V[], at: number): V | undefined {
  let oldest: V | undefined;
  for (const v of pool) {
    if (v.startedAt < at - RETRIGGER_EPS && (!oldest || v.startedAt < oldest.startedAt)) oldest = v;
  }
  return oldest;
}
