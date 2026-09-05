# 同频 AI 黄白视觉恢复

## Comparison target

用户反馈暗色比之前难看。本轮撤回整页暗色覆盖，直接复用原有
`chat-layout.css` 与 `sidebar-layout.css` 的黄白配色，不另造主题。

Source: `../ai-layout-20260905/05-final-desktop.png`.
Implementation: `desktop.png`.
Both are 1023×933 pixels at a 1023×933 CSS viewport, matching empty-chat state
and collapsed ordinary-conversation group. Both images were opened together in
one comparison input. No density normalization or cropping was needed.

## Findings and fixes

- [P1, fixed] The dark full-page material palette diverged from the user's preferred
  prior surface. Removed its document, sidebar, chat, dialog, menu and account
  overrides; light backgrounds and dark text now inherit the original theme.
- Kept the previous interaction fixes: beam wrapper allows overflow, images have
  explicit bounds, mobile navigation fits, hidden Orb and reduced-motion handling
  remain intact. No storage or quota code changed.
- Adjusted MetalFx and Beam to their light theme. The original yellow logo is no
  longer grayscale; the welcome identity is smaller. Beam is monochrome at 0.28
  strength instead of ocean at 0.5, with a 16 px radius matching the original composer.

## Required visual surfaces

- Typography: restored the original inherited font, dark text and 700-weight
  welcome heading. Sidebar labels, wrapping and title hierarchy match the reference.
- Spacing: same sidebar width, header, headline, composer and account positions.
  The 88 px logo rim intentionally replaces the smaller reference sparkle icon.
- Colors: chat background verified `rgb(250, 247, 239)`, page text `rgb(23, 23, 23)`,
  and `color-scheme: light`. Buttons and panels inherit the previous muted yellows.
- Images: reused the original Tongpin logo and existing licensed renderers. Logo
  ratio is preserved, with a subtle silver rim rather than a dark disc.
- Copy/content: unchanged; no additional explanation or demo copy was introduced.

At this viewport the relevant labels, logo edge and composer controls are legible
in the full-view comparison, so an additional cropped comparison was unnecessary.

## Browser checks

- `plus-menu.png`: all four entries visible; Escape closes it without clipping.
- `project-dialog.png`: yellow/white confirmation with dark readable labels;
  cancellation does not create a project.
- `token-dialog.png`: light usage dialog; unchanged unsynced values.
- `mobile.png`: 390×844, document scroll width equals 390; no horizontal overflow.
- Ordinary conversation collapse still docks above the profile. Desktop expanded
  sidebar restored after mobile verification.
- Browser warning/error query returned no entries.

## Validation

- TypeScript check: passed.
- 3 targeted test files / 15 tests: passed. Theme regression now rejects dark
  color-scheme and document-background overrides, rather than requiring them.
- Production web build: passed.
- `git diff --check`: passed.

This is a local visual correction. No model service, deployment or release added.

final result: passed
