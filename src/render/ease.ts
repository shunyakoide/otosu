/** 速く出て、ゆっくり止まる（p: 0 → 1） */
export const easeOutCubic = (p: number): number => 1 - (1 - p) ** 3;
