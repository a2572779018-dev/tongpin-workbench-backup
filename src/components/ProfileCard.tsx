import { Camera, X } from "lucide-react";
import type { User } from "../types";
import { UserAvatar } from "./UserAvatar";

const ROLE_LABEL = {
  member: "成员",
  boss: "老板",
  admin: "管理员",
} as const;

export function ProfileCard({
  user,
  onClose,
  onChangeAvatar,
}: {
  user: User;
  onClose: () => void;
  onChangeAvatar?: () => void;
}) {
  return (
    <div className="profile-card-layer">
      <button
        className="profile-card-backdrop"
        type="button"
        aria-label="关闭资料卡"
        onClick={onClose}
      />
      <section
        className="profile-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-card-name"
      >
        <button
          className="profile-card__close"
          type="button"
          aria-label="关闭资料卡"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <UserAvatar user={user} className="profile-card__avatar" />
        <div className="profile-card__copy">
          <span>{ROLE_LABEL[user.role]}</span>
          <h2 id="profile-card-name">{user.name}</h2>
          <p>{user.jobTitle || ROLE_LABEL[user.role]}</p>
        </div>
        {onChangeAvatar && (
          <button
            className="profile-card__action"
            type="button"
            onClick={onChangeAvatar}
          >
            <Camera size={16} />
            更换头像
          </button>
        )}
      </section>
    </div>
  );
}
