const CUSTOM_EMOJI_RE = /^<a?:[A-Za-z0-9_]+:(\d+)>$/;

export interface ReactionEmoji {
  id: string | null;
  name: string | null;
}

export function emojiKeyFromInput(input: string): string {
  const trimmed = input.trim();
  const custom = CUSTOM_EMOJI_RE.exec(trimmed);
  if (custom) return custom[1];

  const idPart = /(?:^|:)(\d{16,22})$/.exec(trimmed);
  if (idPart) return idPart[1];

  return trimmed;
}

export function emojiKeyFromReaction(reaction: {
  emoji: ReactionEmoji;
}): string {
  return reaction.emoji.id ?? reaction.emoji.name ?? "";
}
