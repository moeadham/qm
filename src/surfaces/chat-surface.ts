export interface ChatSurface {
  label: string;
  mentionHint: string;
  linkHint: string;
}

const CHAT_SURFACES: Readonly<Record<string, ChatSurface>> = {
  slack: {
    label: "Slack",
    mentionHint:
      " To @-mention on Slack, use `<@U…>` for a person or `<!subteam^S…>` for a user group (ids appear in People here / read / search results). A typed `@name` is plain text and pings no one; @here/@channel/@everyone never ping.",
    linkHint: "; Slack-style links are also supported: `<https://example.com|label>`",
  },
};

export function chatSurface(surface: string | undefined): ChatSurface | undefined {
  return surface !== undefined && Object.hasOwn(CHAT_SURFACES, surface) ? CHAT_SURFACES[surface] : undefined;
}

export function isChatSurface(surface: string | undefined): boolean {
  return chatSurface(surface) !== undefined;
}
