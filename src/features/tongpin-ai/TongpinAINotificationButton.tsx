import { Bell } from "lucide-react";

interface TongpinAINotificationButtonProps {
  unread: number;
  onClick?: () => void;
}

export function TongpinAINotificationButton({
  unread,
  onClick,
}: TongpinAINotificationButtonProps) {
  return (
    <button
      type="button"
      className="tp-ai-notification-button"
      aria-label={`消息中心${unread ? `，${unread} 条未读` : ""}`}
      title={onClick ? "打开消息中心" : "消息中心当前不可用"}
      disabled={!onClick}
      onClick={onClick}
    >
      <Bell size={18} />
      {unread > 0 && <span aria-hidden="true">{unread > 9 ? "9+" : unread}</span>}
    </button>
  );
}
