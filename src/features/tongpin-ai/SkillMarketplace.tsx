import {
  ArrowLeft,
  BarChart3,
  Check,
  FilePenLine,
  Megaphone,
  MessagesSquare,
  PanelLeft,
  Presentation,
  Search,
  Sparkles,
  Telescope,
} from "lucide-react";
import { useMemo, useState, type ComponentType } from "react";
import type { LucideProps } from "lucide-react";
import { TONGPIN_AI_SKILLS } from "./mockData";
import type { TongpinAISkillIcon } from "./types";
import { TongpinAINotificationButton } from "./TongpinAINotificationButton";

const SKILL_ICONS: Record<TongpinAISkillIcon, ComponentType<LucideProps>> = {
  writing: FilePenLine,
  research: Telescope,
  slides: Presentation,
  data: BarChart3,
  meeting: MessagesSquare,
  campaign: Megaphone,
};

const CATEGORIES = ["全部", "内容", "研究", "办公", "增长"] as const;
type SkillCategory = (typeof CATEGORIES)[number];

interface SkillMarketplaceProps {
  enabledSkillIds: Set<string>;
  notificationUnread: number;
  onBackToChat: () => void;
  onOpenNotifications?: () => void;
  onToggleSkill: (skillId: string) => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

export function SkillMarketplace({
  enabledSkillIds,
  notificationUnread,
  onBackToChat,
  onOpenNotifications,
  onToggleSkill,
  sidebarCollapsed = false,
  onToggleSidebar,
}: SkillMarketplaceProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<SkillCategory>("全部");

  const visibleSkills = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return TONGPIN_AI_SKILLS.filter((skill) => {
      const matchesCategory =
        category === "全部" || skill.category === category;
      const matchesQuery =
        !normalizedQuery ||
        `${skill.name}${skill.description}${skill.category}`
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      return matchesCategory && matchesQuery;
    });
  }, [category, query]);

  return (
    <section className="tp-ai-skills" aria-labelledby="tp-ai-skills-title">
      <header className="tp-ai-skills__header">
        <button
          type="button"
          className="tp-ai-sidebar-toggle tp-ai-skills-sidebar-toggle"
          aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
          onClick={onToggleSidebar}
        >
          <PanelLeft size={19} />
        </button>
        <button
          type="button"
          className="tp-ai-back-button"
          aria-label="返回对话"
          onClick={onBackToChat}
        >
          <ArrowLeft size={19} />
        </button>
        <div>
          <h2 id="tp-ai-skills-title">Skill 市场</h2>
          <p>最多选择 3 个技能，用于后续对话。</p>
        </div>
        <div className="tp-ai-skills__header-actions">
          <span className="tp-ai-skills__count">
            <b>{TONGPIN_AI_SKILLS.length}</b>
            <small>个可选 Skill</small>
          </span>
          <TongpinAINotificationButton
            unread={notificationUnread}
            onClick={onOpenNotifications}
          />
        </div>
      </header>

      <div className="tp-ai-skills__tools">
        <label className="tp-ai-skill-search">
          <Search size={17} />
          <span className="sr-only">搜索 Skill</span>
          <input
            type="search"
            value={query}
            placeholder="搜索 Skill"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div
          className="tp-ai-skill-categories"
          role="group"
          aria-label="Skill 分类"
        >
          {CATEGORIES.map((item) => (
            <button
              key={item}
              type="button"
              className={category === item ? "is-active" : ""}
              aria-pressed={category === item}
              onClick={() => setCategory(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      {visibleSkills.length > 0 ? (
        <div className="tp-ai-skill-grid">
          {visibleSkills.map((skill) => {
            const Icon = SKILL_ICONS[skill.icon];
            const selected = enabledSkillIds.has(skill.id);
            return (
              <article
                key={skill.id}
                className={`tp-ai-skill-card is-${skill.accent}`}
              >
                <header>
                  <span className="tp-ai-skill-card__icon" aria-hidden="true">
                    <Icon size={24} strokeWidth={2.2} />
                  </span>
                  <span className="tp-ai-skill-card__category">
                    {skill.category}
                  </span>
                </header>
                <div>
                  <h3>{skill.name}</h3>
                  <p>{skill.description}</p>
                </div>
                <footer>
                  <span>本地选择</span>
                  <button
                    type="button"
                    className={selected ? "is-enabled" : ""}
                    aria-label={`${selected ? "取消选择" : "选择"} Skill：${skill.name}`}
                    aria-pressed={selected}
                    onClick={() => onToggleSkill(skill.id)}
                  >
                    {selected ? <Check size={15} /> : <Sparkles size={15} />}
                    {selected ? "已选择" : "选择"}
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="tp-ai-skill-empty">
          <Search size={28} />
          <strong>没有找到匹配的 Skill</strong>
          <p>换个关键词，或切回“全部”继续看看。</p>
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setCategory("全部");
            }}
          >
            清除筛选
          </button>
        </div>
      )}
    </section>
  );
}
