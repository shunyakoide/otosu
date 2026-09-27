// 描画の重さに合わせて画質を下げる（D27）。端末の GPU は測ってみないと分からないので、
// 実際のフレーム時間を見て、遅いときだけ段階を1つずつ下げる（戻すと行き来してちらつくので上げない）。

/** 画質の段階。samples は MSAA、scale は後処理の解像度（設定の解像度に掛ける） */
export type QualityLevel = { samples: number; scale: number };

export const QUALITY_LEVELS: readonly QualityLevel[] = [
  { samples: 4, scale: 1 },
  { samples: 0, scale: 1 },
  { samples: 0, scale: 0.75 },
  { samples: 0, scale: 0.6 },
];

/** この秒数ごとに平均のフレーム時間を見る */
const WINDOW_SEC = 2;
/** 平均がこれ（秒）より長ければ1段下げる（48fps 相当。60/120Hz どちらの画面でも余裕があれば超えない） */
const SLOW_SEC = 1 / 48;
/** これより長いフレームは数えない（タブの切り替えや読み込みの一瞬の止まり） */
const HITCH_SEC = 0.1;

export class QualityGovernor {
  level = 0;
  private sum = 0;
  private frames = 0;

  /** 1フレームごとに呼ぶ。段階を変えたときだけ新しい段階を返す */
  update(dt: number): QualityLevel | null {
    if (dt <= 0 || dt >= HITCH_SEC) return null;
    this.sum += dt;
    this.frames++;
    if (this.sum < WINDOW_SEC) return null;
    const mean = this.sum / this.frames;
    this.sum = 0;
    this.frames = 0;
    if (mean <= SLOW_SEC || this.level >= QUALITY_LEVELS.length - 1) return null;
    this.level++;
    return QUALITY_LEVELS[this.level]!;
  }

  /** 測り直す（解像度の設定を変えたとき） */
  reset(): QualityLevel {
    this.level = 0;
    this.sum = 0;
    this.frames = 0;
    return QUALITY_LEVELS[0]!;
  }
}
