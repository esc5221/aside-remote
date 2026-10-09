# Aside Remote — Mobile Conversation UI

Aside uses a restrained, monochrome conversation interface inspired by ChatGPT on iOS. UI copy is English. Existing conversation content keeps its original language.

## Reference and layout

- Current reference: [ChatGPT for iOS](https://apps.apple.com/us/app/chatgpt/id6448311069), version 1.2026.272 listed on October 10, 2026. Store screenshots and public mobile screenshots inform the conversation shell, rounded composer, and outline controls; no ChatGPT branding or unsupported voice controls are included.
- Mobile: a full-height conversation with a 64px header, independently scrolling messages, and an anchored composer. The conversation drawer opens modally below 821px.
- Desktop: a 288px conversation sidebar and the same conversation surface. Text is bounded to 736px and the composer to 768px.
- Browser and settings open in accessible dialogs. Browser captures preserve their source colors and aspect ratio. Conversation deletion requires explicit confirmation and remains blocked during a run.
- The visible viewport controls shell height so the composer stays above a mobile keyboard. Safe-area insets cover the header, composer, and drawers.

## Tokens and typography

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | `#ffffff` | `#212121` |
| Sidebar / composer / code | `#f7f7f7` | `#2f2f2f` |
| User bubble | `#f1f1f1` | `#303030` |
| Text | `#171717` | `#f3f3f3` |
| Secondary text | `#737373` | `#b4b4b4` |
| Border | `#e9e9e9` | `#414141` |
| Hover | `#ededed` | `#3b3b3b` |
| Error | `#b42318` | `#ff9b91` |
| Composer / dialog radius | `28px` | `28px` |
| User bubble radius | `24px` | `24px` |

Wanted Sans is the only selectable or loaded typeface, including UI controls and code. Fonts load through the existing same-origin proxy. Body text uses 16px / 1.7; user messages use 16px / 1.55; header text uses 19px, weight 650. Inputs remain at least 16px to avoid iOS focus zoom.

`global.css` owns the light/dark color values, reset, and Markdown descendant rules. `web/src/tokens.stylex.ts` exposes these colors and typography to component styles. StyleX extracts component styles at build time.

Settings → Appearance exposes a Dark mode switch. Light is the default; an explicit choice persists in browser storage and applies before React mounts. The theme covers conversations, drawers, dialogs, code highlighting, and toasts. Images, browser captures, and rendered diagrams retain their source colors; diagrams use a light backing for contrast.

## Controls and states

- Outline icons use Lucide with consistent rounded strokes, usually 1.8px. The menu uses two horizontal lines; the new-chat control uses a square and pencil. The black send control has a white upward arrow and becomes a solid stop control while running.
- No ornamental sparkles, robot marks, promotional cards, or artificial metrics appear in the interface.
- Buttons expose accessible names and visible keyboard focus. Dialogs trap focus and support Escape; reduced-motion settings disable smooth scrolling.
- General text and URLs wrap at any character. Tables and fenced code scroll within their own region and do not widen the app.
- Auto-scroll follows incoming content while the reader is near the bottom. Scrolling upward preserves the reading position and shows a jump-to-latest control. Sending a new message returns to the latest turn.
- Attachments show upload state, can be removed, and remain recoverable when a response fails to start. Resized PNG/WebP images preserve transparency; GIF files keep their animation.
- Toasts report copy, authentication, upload, deletion, and connection errors. Errors never erase the user's draft.

## Conversation lifecycle

Explicitly opening a conversation persists its ID. Initial load restores the saved conversation, including when a browser/settings panel is open; without a saved selection it opens the latest conversation. Explicit New chat persists the empty conversation choice until a message creates a session or the user selects an existing conversation.

Each send has a request ID. Late responses cannot reselect a conversation after navigation. The bridge keeps a bounded request-status registry so reconnecting clients can recover a delivery without sending the prompt twice. Reconnection reloads canonical messages before subscribing to the stream. Polling also recovers completion when a stream event is missed.

## Verification

Use the production build as well as the development server. Verify 320px, 375px, 390px, 430px, desktop, and short landscape viewports. Exercise new conversations, continuation, restored selections, search, drawer navigation, browser preview, long draft input, long unbroken responses, tables/code, disclosure state, copy feedback, attachment removal, and confirmation cancellation.
