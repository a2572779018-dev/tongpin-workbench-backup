export function hasConversationActivity(
  conversationId: string | null | undefined,
  activities: Readonly<Record<string, unknown>>,
  requests: ReadonlyMap<string, unknown>,
  pending: ReadonlySet<string>,
  typing: ReadonlyMap<string, unknown>,
) {
  return Boolean(conversationId && (
    activities[conversationId]
    || requests.has(conversationId)
    || pending.has(conversationId)
    || typing.has(conversationId)
  ));
}
