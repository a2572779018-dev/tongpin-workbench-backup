import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  ArrowLeft,
  Flame,
  MessageCircle,
  Plus,
  Search,
  Send,
  UserPlus,
  UsersRound,
} from "lucide-react";
import { formatTime } from "../lib/date";
import type {
  ContactSummary,
  DirectMessage,
  DirectMessageRealtimeEvent,
  User,
} from "../types";
import { ProfileCard } from "./ProfileCard";
import { UserAvatar } from "./UserAvatar";

type ApiClient = <T>(
  path: string,
  options?: RequestInit,
) => Promise<T>;

const ROLE_LABEL = {
  member: "成员",
  boss: "老板",
  admin: "管理员",
} as const;

function messagePreview(message: DirectMessage | null): string {
  if (!message) return "开始聊天";
  if (message.mode === "flash") {
    return message.destroyedAt
      ? "一条同频闪信已阅并隐去"
      : "同频闪信";
  }
  return message.body;
}

export function ContactCenter({
  api,
  currentUser,
  realtimeEvent,
  onUnreadChange,
}: {
  api: ApiClient;
  currentUser: User;
  realtimeEvent: DirectMessageRealtimeEvent | null;
  onUnreadChange: (count: number) => void;
}) {
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [selected, setSelected] = useState<ContactSummary | null>(null);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [chatLoading, setChatLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState(false);
  const [flashMode, setFlashMode] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [profileUser, setProfileUser] = useState<User | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [error, setError] = useState("");
  const messageEndRef = useRef<HTMLDivElement | null>(null);

  const applyContacts = useCallback(
    (next: ContactSummary[]) => {
      setContacts(next);
      onUnreadChange(
        next.reduce((total, contact) => total + contact.unreadCount, 0),
      );
    },
    [onUnreadChange],
  );

  const loadContacts = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<{
        contacts: ContactSummary[];
        unread: number;
      }>("/api/contacts");
      applyContacts(result.contacts);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "联系人加载失败",
      );
    } finally {
      setLoading(false);
    }
  }, [api, applyContacts]);

  useEffect(() => {
    void loadContacts();
  }, [loadContacts]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const mergeMessages = useCallback((incomingMessages: DirectMessage[]) => {
    setMessages((current) => {
      const next = new Map(current.map((message) => [message.id, message]));
      for (const message of incomingMessages) next.set(message.id, message);
      return [...next.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
    });
  }, []);

  useEffect(() => {
    if (!realtimeEvent) return;
    if (
      realtimeEvent.type === "message:new" &&
      selected?.user.id === realtimeEvent.sender.id
    ) {
      setMessages((current) => [
        ...current.filter(
          (message) => message.id !== realtimeEvent.message.id,
        ),
        realtimeEvent.message,
      ]);
      void api<{ messages?: DirectMessage[] }>(
        `/api/contacts/${realtimeEvent.sender.id}/read`,
        { method: "PATCH" },
      )
        .then((result) => mergeMessages(result.messages ?? []))
        .finally(() => void loadContacts());
      return;
    }
    if (
      realtimeEvent.type === "message:read" ||
      realtimeEvent.type === "message:expired"
    ) {
      mergeMessages([realtimeEvent.message]);
      void loadContacts();
      return;
    }
    void loadContacts();
  }, [
    api,
    loadContacts,
    mergeMessages,
    realtimeEvent,
    selected?.user.id,
  ]);

  useEffect(() => {
    if (
      !messages.some(
        (message) =>
          message.mode === "flash" &&
          message.expiresAt &&
          !message.destroyedAt,
      )
    ) {
      return;
    }
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [messages]);

  async function searchContacts(event: FormEvent) {
    event.preventDefault();
    const query = searchText.trim();
    if (!query) return;
    setSearching(true);
    setError("");
    try {
      const result = await api<{ users: User[] }>(
        `/api/contacts/search?q=${encodeURIComponent(query)}`,
      );
      setSearchResults(result.users);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "搜索失败");
    } finally {
      setSearching(false);
    }
  }

  async function addContact(user: User) {
    setError("");
    try {
      const result = await api<{ contact: ContactSummary }>(
        "/api/contacts",
        {
          method: "POST",
          body: JSON.stringify({ userId: user.id }),
        },
      );
      await loadContacts();
      await openChat(result.contact);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "联系人添加失败",
      );
    }
  }

  async function openChat(contact: ContactSummary) {
    setSelected(contact);
    setChatLoading(true);
    setError("");
    try {
      const result = await api<{ messages: DirectMessage[] }>(
        `/api/contacts/${contact.user.id}/messages`,
      );
      setMessages(result.messages);
      const readResult = await api<{ messages?: DirectMessage[] }>(
        `/api/contacts/${contact.user.id}/read`,
        {
        method: "PATCH",
        },
      );
      mergeMessages(readResult.messages ?? []);
      await loadContacts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "消息加载失败");
    } finally {
      setChatLoading(false);
    }
  }

  async function sendMessage() {
    const body = draft.trim();
    if (!body || !selected || sending) return;
    setSending(true);
    setError("");
    try {
      const result = await api<{ message: DirectMessage }>(
        `/api/contacts/${selected.user.id}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            body,
            mode: flashMode ? "flash" : "normal",
          }),
        },
      );
      setMessages((current) => [...current, result.message]);
      setDraft("");
      void loadContacts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "消息发送失败");
    } finally {
      setSending(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  if (selected) {
    return (
      <section className="chat-panel" aria-label={`与 ${selected.user.name} 聊天`}>
        <header className="chat-panel__person">
          <button
            className="icon-button"
            type="button"
            aria-label="返回联系人"
            onClick={() => setSelected(null)}
          >
            <ArrowLeft size={18} />
          </button>
          <button
            className="chat-profile-trigger"
            type="button"
            aria-label={`查看 ${selected.user.name} 的资料`}
            onClick={() => setProfileUser(selected.user)}
          >
            <UserAvatar user={selected.user} className="contact-avatar" />
          </button>
          <span>
            <b>{selected.user.name}</b>
            <small>
              {selected.user.jobTitle || ROLE_LABEL[selected.user.role]}
            </small>
          </span>
        </header>

        <div className="chat-message-list" aria-live="polite">
          {chatLoading ? (
            <div className="contact-loading">正在加载消息…</div>
          ) : messages.length === 0 ? (
            <div className="chat-empty">
              <span>
                <MessageCircle size={24} />
              </span>
              <b>直接开始说事</b>
            </div>
          ) : (
            messages.map((message) => {
              const mine = message.senderId === currentUser.id;
              const hidden =
                Boolean(message.destroyedAt) ||
                Boolean(
                  message.mode === "flash" &&
                    message.expiresAt &&
                    Date.parse(message.expiresAt) <= clock,
                );
              const secondsLeft =
                message.mode === "flash" && message.expiresAt && !hidden
                  ? Math.max(
                      0,
                      Math.ceil((Date.parse(message.expiresAt) - clock) / 1000),
                    )
                  : null;
              return (
                <article
                  key={message.id}
                  className={[
                    "chat-bubble",
                    mine ? "is-mine" : "is-theirs",
                    message.mode === "flash" ? "is-flash" : "",
                    hidden ? "is-hidden" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {message.mode === "flash" && <Flame size={14} />}
                  <p>
                    {hidden ? "一条同频闪信已阅并隐去" : message.body}
                  </p>
                  <time>
                    {formatTime(message.createdAt)}
                    {secondsLeft !== null && message.readAt
                      ? ` · ${secondsLeft} 秒后隐去`
                      : ""}
                  </time>
                </article>
              );
            })
          )}
          <div ref={messageEndRef} />
        </div>

        {error && <div className="chat-error">{error}</div>}
        {flashMode && (
          <div className="flash-mode-bar">
            <Flame size={15} />
            同频闪信
            <button type="button" onClick={() => setFlashMode(false)}>
              关闭
            </button>
          </div>
        )}
        <div className="chat-composer">
          <div className="chat-composer__extra">
            <button
              type="button"
              className={toolsOpen ? "is-active" : ""}
              aria-label="更多消息功能"
              aria-expanded={toolsOpen}
              onClick={() => setToolsOpen((current) => !current)}
            >
              <Plus size={18} />
            </button>
            {toolsOpen && (
              <div className="chat-tool-menu">
                <button
                  type="button"
                  className={flashMode ? "is-active" : ""}
                  onClick={() => {
                    setFlashMode((current) => !current);
                    setToolsOpen(false);
                  }}
                >
                  <Flame size={16} />
                  {flashMode ? "关闭同频闪信" : "开启同频闪信"}
                </button>
              </div>
            )}
          </div>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="输入消息…"
            maxLength={500}
            rows={2}
            aria-label="消息内容"
          />
          <button
            type="button"
            aria-label="发送消息"
            disabled={!draft.trim() || sending}
            onClick={() => void sendMessage()}
          >
            <Send size={18} />
          </button>
        </div>
        {profileUser && (
          <ProfileCard
            user={profileUser}
            onClose={() => setProfileUser(null)}
          />
        )}
      </section>
    );
  }

  return (
    <section className="contacts-panel" aria-label="联系人">
      <form className="contact-search" onSubmit={searchContacts}>
        <Search size={17} />
        <input
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          placeholder="按姓名搜索"
          maxLength={30}
          aria-label="按姓名搜索联系人"
        />
        <button type="submit" disabled={!searchText.trim() || searching}>
          {searching ? "搜索中" : "搜索"}
        </button>
      </form>

      {error && <div className="chat-error">{error}</div>}

      {searchResults.length > 0 && (
        <div className="contact-search-results">
          {searchResults.map((user) => {
            const existing = contacts.find(
              (contact) => contact.user.id === user.id,
            );
            return (
              <article key={user.id} className="contact-person">
                <UserAvatar user={user} className="contact-avatar" />
                <span>
                  <b>{user.name}</b>
                  <small>{user.jobTitle || ROLE_LABEL[user.role]}</small>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    existing
                      ? void openChat(existing)
                      : void addContact(user)
                  }
                >
                  {existing ? (
                    <MessageCircle size={16} />
                  ) : (
                    <UserPlus size={16} />
                  )}
                  {existing ? "聊天" : "添加"}
                </button>
              </article>
            );
          })}
        </div>
      )}

      <div className="contact-list">
        {loading ? (
          <div className="contact-loading">正在加载联系人…</div>
        ) : contacts.length === 0 ? (
          <div className="contact-empty">
            <span>
              <UsersRound size={24} />
            </span>
            <b>还没有联系人</b>
          </div>
        ) : (
          contacts.map((contact) => (
            <button
              key={contact.user.id}
              type="button"
              className="contact-row"
              onClick={() => void openChat(contact)}
            >
              <UserAvatar
                user={contact.user}
                className="contact-avatar"
              />
              <span className="contact-row__copy">
                <span>
                  <b>{contact.user.name}</b>
                  <small>
                    {contact.user.jobTitle || ROLE_LABEL[contact.user.role]}
                  </small>
                </span>
                <p>
                  {messagePreview(contact.lastMessage)}
                </p>
              </span>
              <span className="contact-row__meta">
                {contact.lastMessage && (
                  <time>{formatTime(contact.lastMessage.createdAt)}</time>
                )}
                {contact.unreadCount > 0 && (
                  <i>{contact.unreadCount > 9 ? "9+" : contact.unreadCount}</i>
                )}
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}
