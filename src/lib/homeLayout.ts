export type HomeLayout =
  | "lanes"
  | "classic"
  | "cards-yellow";

export const HOME_LAYOUT_OPTIONS: readonly HomeLayout[] = [
  "lanes",
  "classic",
  "cards-yellow",
];

export const HOME_LAYOUT_LABELS: Record<HomeLayout, string> = {
  lanes: "状态跑道 · 拼色",
  classic: "经典视图",
  "cards-yellow": "状态跑道 · 同频黄",
};

export const HOME_LAYOUT_DESCRIPTIONS: Record<HomeLayout, string> = {
  lanes: "当前高饱和版本",
  classic: "原始日期卡片版本",
  "cards-yellow": "统一黄卡，状态区域更明确",
};

const LEGACY_CANDIDATE_LAYOUTS: Record<string, HomeLayout> = {
  "lanes-blue": "cards-yellow",
  "lanes-slate": "cards-yellow",
  "lanes-sage": "cards-yellow",
  "lanes-white": "cards-yellow",
  "lanes-yellow": "cards-yellow",
  "lanes-ink": "cards-yellow",
  "cards-white": "cards-yellow",
  "cards-ink": "cards-yellow",
};

export function isLaneHomeLayout(layout: HomeLayout): boolean {
  return layout !== "classic";
}

export function homeLayoutStorageKey(userId: string): string {
  return `tongpin:home-layout:${userId}`;
}

export function readHomeLayout(userId: string): HomeLayout {
  try {
    const stored = localStorage.getItem(homeLayoutStorageKey(userId));
    if (stored && LEGACY_CANDIDATE_LAYOUTS[stored]) {
      return LEGACY_CANDIDATE_LAYOUTS[stored];
    }
    return HOME_LAYOUT_OPTIONS.includes(stored as HomeLayout)
      ? (stored as HomeLayout)
      : "lanes";
  } catch {
    return "lanes";
  }
}

export function saveHomeLayout(userId: string, layout: HomeLayout): void {
  try {
    localStorage.setItem(homeLayoutStorageKey(userId), layout);
  } catch {
    // 本地偏好写入失败时仍可继续使用当前视图。
  }
}

