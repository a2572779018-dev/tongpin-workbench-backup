import { createContext, useContext, useMemo, type ReactNode } from "react";

/** GFM task lists (`- [ ]` / `- [x]`) as a read-only checklist. remark-gfm
 * marks the list `contains-task-list` and each task item `task-list-item`
 * with a disabled checkbox `input`; nothing here is interactive, so a reply
 * can never pretend a user ticked something. */

type HastNode = { type?: unknown; tagName?: unknown; properties?: unknown; children?: unknown };

function asNode(value: unknown): HastNode | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as HastNode : null;
}

function children(node: HastNode): HastNode[] {
  return Array.isArray(node.children) ? node.children.map(asNode).filter((item): item is HastNode => item !== null) : [];
}

function hasClass(value: unknown, name: string): boolean {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\s+/) : [];
  return list.includes(name);
}

function isElement(node: HastNode, tagName: string): boolean {
  return node.type === "element" && node.tagName === tagName;
}

function properties(node: HastNode): Record<string, unknown> {
  const value = asNode(node.properties);
  return value ? value as Record<string, unknown> : {};
}

/** Checked state of a `li.task-list-item`: its checkbox sits directly in the
 * item (tight list) or in the item's first paragraph (loose list). */
function taskItemChecked(item: HastNode): boolean {
  const direct = children(item);
  const input = direct.find(node => isElement(node, "input"))
    ?? children(direct.find(node => isElement(node, "p")) ?? {}).find(node => isElement(node, "input"));
  return input ? properties(input).checked === true : false;
}

/** Done / total task items in a list, including nested task lists. */
export function taskListProgress(list: unknown): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const visit = (node: HastNode) => {
    for (const child of children(node)) {
      if (isElement(child, "li") && hasClass(properties(child).className, "task-list-item")) {
        total += 1;
        if (taskItemChecked(child)) done += 1;
      }
      visit(child);
    }
  };
  const root = asNode(list);
  if (root) visit(root);
  return { done, total };
}

/** Nested task lists render inside the top-level checklist, without a second header. */
const InsideTaskList = createContext(false);

type ListProps = { node?: unknown; className?: string; start?: number; children?: ReactNode };
const NO_TASKS = { done: 0, total: 0 };

function ReplyList({ ordered, node, className, start, children: items }: ListProps & { ordered: boolean }) {
  const nested = useContext(InsideTaskList);
  const tasks = hasClass(className, "contains-task-list");
  const progress = useMemo(() => tasks ? taskListProgress(node) : NO_TASKS, [node, tasks]);
  const renderList = (listClass: string | undefined) => ordered
    ? <ol className={listClass} start={start}>{items}</ol>
    : <ul className={listClass}>{items}</ul>;
  if (!tasks) return renderList(className);
  const list = renderList("contains-task-list tp-ai-tasklist__items");
  if (nested || !progress.total) return list;
  const { done, total } = progress;
  const percent = Math.round(done / total * 100);
  return <div className={`tp-ai-tasklist${done === total ? " is-complete" : ""}`} role="group" aria-label={`任务清单，已完成 ${done}/${total}`}>
    <div className="tp-ai-tasklist__head" aria-hidden="true">
      <span className="tp-ai-tasklist__title">任务清单</span>
      <span className="tp-ai-tasklist__meter"><span style={{ width: `${percent}%` }} /></span>
      <span className="tp-ai-tasklist__count">{done}/{total}</span>
    </div>
    <InsideTaskList.Provider value>{list}</InsideTaskList.Provider>
  </div>;
}

export function ReplyUnorderedList(props: ListProps) {
  return <ReplyList {...props} ordered={false} />;
}

export function ReplyOrderedList(props: ListProps) {
  return <ReplyList {...props} ordered />;
}

/** `id` is kept so GFM footnote items stay addressable. */
export function ReplyListItem({ node, id, className, children: content }: { node?: unknown; id?: string; className?: string; children?: ReactNode }) {
  if (!hasClass(className, "task-list-item")) return <li id={id} className={className}>{content}</li>;
  const item = asNode(node);
  const done = item ? taskItemChecked(item) : false;
  return <li id={id} className={`task-list-item tp-ai-task${done ? " is-done" : ""}`}>{content}</li>;
}

/** The only `input` react-markdown emits (raw HTML is skipped) is a task
 * checkbox; show it as a static mark with its state spelled out. */
export function ReplyTaskCheckbox({ type, checked }: { type?: string; checked?: boolean }) {
  if (type !== "checkbox") return null;
  return <span className={`tp-ai-task__box${checked ? " is-checked" : ""}`} role="img" aria-label={checked ? "已完成" : "未完成"}>
    {checked ? <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2.6 6.4 5 8.7l4.5-5.2" /></svg> : null}
  </span>;
}
