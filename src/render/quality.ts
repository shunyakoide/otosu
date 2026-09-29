// 描画の重さに合わせて画質を下げる（D27）。端末の GPU は測ってみないと分からないので、
// 実際のフレーム時間を見て、遅いときだけ段階を1つずつ下げる。
// 図形をまとめて足した直後など、一時的に重かっただけで下がったままにならないよう、速い状態がしばらく続いたら
// 1段上げてみる（D67）。上げてすぐ遅くなったら下げ直し、次に試すまでの待ちを倍にする（行き来のちらつきを減らす）。

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
/** 平均がこれより短い窓だけを「速い」と数える（57fps 相当。60Hz の画面で張り付いていれば満たす） */
const FAST_SEC = 1 / 57;
/** 速い状態がこの秒数続いたら1段上げてみる。上げてすぐ遅くなるたびに倍にし、MAX で止める */
const UP_WAIT_SEC = 10;
const UP_WAIT_MAX_SEC = 160;
/** 上げてから、この秒数のうちに遅くなったら「上げられなかった」とみる */
const PROBE_SEC = 4;

export class QualityGovernor {
  level = 0;
  private sum = 0;
  private frames = 0;
  /** 速い状態が続いている秒数と、上げてみるまでの待ち */
  private calm = 0;
  private wait = UP_WAIT_SEC;
  /** 上げてみた直後の見張りの残り（秒） */
  private probe = 0;

  /** 1フレームごとに呼ぶ。段階を変えたときだけ新しい段階を返す */
  update(dt: number): QualityLevel | null {
    if (dt <= 0 || dt >= HITCH_SEC) return null;
    this.sum += dt;
    this.frames++;
    if (this.sum < WINDOW_SEC) return null;
    const span = this.sum;
    const mean = span / this.frames;
    this.sum = 0;
    this.frames = 0;
    const probing = this.probe > 0;
    this.probe = Math.max(0, this.probe - span);

    if (mean > SLOW_SEC) {
      this.calm = 0;
      if (this.level >= QUALITY_LEVELS.length - 1) return null;
      // 上げてみたばかりで遅い: 戻して、次に試すまでを延ばす
      if (probing) {
        this.wait = Math.min(UP_WAIT_MAX_SEC, this.wait * 2);
        this.probe = 0;
      }
      this.level++;
      return QUALITY_LEVELS[this.level]!;
    }
    // 見張りの間を遅くならずに過ぎたら、上げられたとみて待ちを戻す
    if (probing && this.probe === 0) this.wait = UP_WAIT_SEC;
    if (this.level === 0 || mean > FAST_SEC) {
      this.calm = 0;
      return null;
    }
    this.calm += span;
    if (this.calm < this.wait) return null;
    this.calm = 0;
    this.probe = PROBE_SEC;
    this.level--;
    return QUALITY_LEVELS[this.level]!;
  }

  /** 測り直す（解像度の設定を変えたとき） */
  reset(): QualityLevel {
    this.level = 0;
    this.sum = 0;
    this.frames = 0;
    this.calm = 0;
    this.wait = UP_WAIT_SEC;
    this.probe = 0;
    return QUALITY_LEVELS[0]!;
  }
}
