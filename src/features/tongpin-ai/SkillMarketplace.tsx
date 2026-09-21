import {
  ArrowLeft,
  BarChart3,
  Bot,
  Boxes,
  Check,
  FileImage,
  FilePenLine,
  Image,
  Megaphone,
  MessagesSquare,
  MonitorCog,
  PanelLeft,
  Presentation,
  Search,
  Sparkles,
  Telescope,
  Video,
  Workflow,
} from "lucide-react";
import { useMemo, useState, type ComponentType } from "react";
import type { LucideProps } from "lucide-react";
import { BASE_CAPABILITIES, CAPABILITY_HUBS, hubIsActive, hubSkillNames, type CapabilityCenterSection } from "./capabilityCatalog";
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

const BASE_ICONS = {
  chat: Bot,
  attachments: FileImage,
  image: Image,
  video: Video,
  presentation: Presentation,
  computer: MonitorCog,
} as const;

interface SkillMarketplaceProps {
  enabledSkillIds: Set<string>;
  notificationUnread: number;
  onBackToChat: () => void;
  onOpenNotifications?: () => void;
  onToggleSkill: (skillId: string) => void;
  onApplySkillSet?: (skillIds: readonly string[]) => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

export function SkillMarketplace({
  enabledSkillIds,
  notificationUnread,
  onBackToChat,
  onOpenNotifications,
  onToggleSkill,
  onApplySkillSet,
  sidebarCollapsed = false,
  onToggleSidebar,
}: SkillMarketplaceProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<SkillCategory>("全部");
  const [section, setSection] = useState<CapabilityCenterSection>("base");

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
          <h2 id="tp-ai-skills-title">AI 能力中心</h2>
          <p>基础能力、Skill 和 Hub 工作流分层管理，执行仍在对话中发起。</p>
        </div>
        <div className="tp-ai-skills__header-actions">
          <span className="tp-ai-skills__count">
            <b>{BASE_CAPABILITIES.length + TONGPIN_AI_SKILLS.length + CAPABILITY_HUBS.length}</b>
            <small>项能力</small>
          </span>
          <TongpinAINotificationButton
            unread={notificationUnread}
            onClick={onOpenNotifications}
          />
        </div>
      </header>

      <nav className="tp-ai-capability-tabs" aria-label="AI 能力分类">
        {([
          ["base", "基础能力", Bot],
          ["skills", "Skill", Sparkles],
          ["hubs", "Hub 工作流", Workflow],
        ] as const).map(([id, label, Icon]) => <button key={id} type="button" className={section === id ? "is-active" : ""}
          aria-current={section === id ? "page" : undefined} onClick={() => setSection(id)}><Icon size={17} />{label}</button>)}
      </nav>

      {section === "skills" && <div className="tp-ai-skills__tools">
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
      </div>}

      {section === "base" ? <div className="tp-ai-capability-grid">
        {BASE_CAPABILITIES.map(item => {
          const Icon = BASE_ICONS[item.id];
          return <article key={item.id} className="tp-ai-capability-card"><span aria-hidden="true"><Icon size={23} /></span>
            <div><h3>{item.name}</h3><p>{item.description}</p></div><small>{item.availability}</small></article>;
        })}
      </div> : section === "hubs" ? <div className="tp-ai-hub-grid">
        {CAPABILITY_HUBS.map(hub => {
          const active = hubIsActive(hub, enabledSkillIds);
          return <article key={hub.id} className={`tp-ai-hub-card${active ? " is-active" : ""}`}>
            <header><span aria-hidden="true"><Boxes size={22} /></span><small>Hub</small></header>
            <div><h3>{hub.name}</h3><p>{hub.description}</p><ol>{hub.steps.map(step => <li key={step.id}>{step.title}</li>)}</ol><ul>{hubSkillNames(hub).map(name => <li key={name}>{name}</li>)}</ul><small>对话中输入 @{hub.id} 按此步骤执行</small></div>
            <footer><span>{active ? "模板 Skill 已就绪" : "启用受限步骤模板"}</span><button type="button" disabled={!onApplySkillSet} className={active ? "is-enabled" : ""}
              onClick={() => onApplySkillSet?.(hub.skillIds)}>{active ? <Check size={15} /> : <Workflow size={15} />}{active ? "已应用" : "应用 Hub"}</button></footer>
          </article>;
        })}
      </div> : visibleSkills.length > 0 ? (
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
