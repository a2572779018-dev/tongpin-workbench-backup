import bossAvatarUrl from "../assets/boss-avatar.png";
import { API_URL } from "../lib/api";
import type { User } from "../types";

interface UserAvatarProps {
  user: Pick<
    User,
    | "id"
    | "name"
    | "role"
    | "avatarSeed"
    | "avatarVersion"
    | "hasCustomAvatar"
  >;
  className?: string;
  customSourceOverride?: string | null;
}

function fallbackSeed(user: UserAvatarProps["user"]): number {
  if (Number.isInteger(user.avatarSeed)) return Math.abs(user.avatarSeed) % 6;
  return Array.from(user.id || user.name).reduce(
    (total, character) => (total + character.charCodeAt(0)) % 6,
    0,
  );
}

export function UserAvatar({
  user,
  className = "",
  customSourceOverride,
}: UserAvatarProps) {
  const displayName =
    (typeof user.name === "string" && user.name.trim()) ||
    (typeof user.id === "string" && user.id.trim()) ||
    "同";
  const customSource =
    customSourceOverride === undefined
      ? user.hasCustomAvatar
        ? `${API_URL}/api/avatars/${encodeURIComponent(user.id)}?v=${user.avatarVersion}`
        : null
      : customSourceOverride;
  const imageSource = user.role === "boss" ? bossAvatarUrl : customSource;
  const kind =
    user.role === "boss" ? "boss" : imageSource ? "custom" : "default";

  return (
    <span
      className={[
        "user-avatar",
        `user-avatar--${kind}`,
        `user-avatar--tone-${fallbackSeed(user)}`,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      role="img"
      aria-label={`${user.name}的头像`}
      data-avatar-kind={kind}
    >
      <b aria-hidden="true">{displayName.slice(0, 1).toUpperCase()}</b>
      {imageSource && (
        <img
          src={imageSource}
          alt=""
          draggable={false}
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      )}
    </span>
  );
}

