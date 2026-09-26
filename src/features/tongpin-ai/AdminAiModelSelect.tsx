import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { filterAiModels } from "./adminAiModels";

export function AdminAiModelSelect({ label, value, models, onChange, onOpen, disabled = false, loading = false, emptyMessage = "先填写服务连接并读取模型", allowCustom = false, placeholder = "选择模型" }: {
  label: string; value: string; models: readonly string[]; onChange: (value: string) => void;
  onOpen?: () => void; disabled?: boolean; loading?: boolean; emptyMessage?: string; allowCustom?: boolean; placeholder?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const options = filterAiModels(models, query);
  useEffect(() => {
    if (open) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, id, open]);
  const choose = (model: string) => { onChange(model); setOpen(false); trigger.current?.focus(); };
  function openList() {
    setQuery(""); setActiveIndex(0); setOpen(true); onOpen?.();
  }
  function keyboard(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(current => Math.max(0, Math.min(options.length - 1, current + (event.key === "ArrowDown" ? 1 : -1))));
    }
    if (event.key === "Enter") { event.preventDefault(); if (options[activeIndex]) choose(options[activeIndex]); }
  }
  return <div className="tp-ai-admin-field tp-ai-model-select" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <span id={`${id}-label`}>{label}</span>
    <button ref={trigger} type="button" className="tp-ai-model-trigger" disabled={disabled}
      aria-labelledby={`${id}-label ${id}-value`} aria-haspopup="listbox" aria-expanded={open}
      aria-controls={`${id}-options`} onClick={() => open ? setOpen(false) : openList()}
      onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); openList(); } }}>
      <span id={`${id}-value`} className={value ? "" : "is-placeholder"}>{value || placeholder}</span><ChevronDown size={16} aria-hidden="true" />
    </button>
    {open ? <div className="tp-ai-model-popover">
      <label className="tp-ai-model-search"><Search size={16} aria-hidden="true" /><input autoFocus value={query}
        role="combobox" aria-label={`搜索${label}`} aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-options`}
        aria-activedescendant={options[activeIndex] ? `${id}-option-${activeIndex}` : undefined}
        placeholder="搜索模型名称…" onChange={event => { setQuery(event.target.value); setActiveIndex(0); }} onKeyDown={keyboard} /></label>
      <div id={`${id}-options`} role="listbox" aria-labelledby={`${id}-label`} className="tp-ai-model-options">
        {options.map((model, index) => <button type="button" role="option" aria-selected={value === model}
          id={`${id}-option-${index}`} key={model} className={index === activeIndex ? "is-active" : ""}
          onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(model)}><span>{model}</span>{model === value ? <Check size={15} aria-hidden="true" /> : null}</button>)}
        {!options.length ? <p role="status">{loading ? "正在读取模型…" : models.length ? "没有匹配的模型" : emptyMessage}</p> : null}
      </div>
      {allowCustom && query.trim() && !models.includes(query.trim()) ? <button type="button" className="tp-ai-model-custom" onClick={() => choose(query.trim())}>使用模型 ID：{query.trim()}</button> : null}
    </div> : null}
  </div>;
}
