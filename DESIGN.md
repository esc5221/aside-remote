# Aside Remote — Mobile Conversation UI

Aside uses a restrained, monochrome conversation interface inspired by ChatGPT on iOS. UI copy is English. Existing conversation content keeps its original language.

## Reference and layout

- Current reference: [ChatGPT for iOS](https://apps.apple.com/us/app/chatgpt/id6448311069), version 1.2026.272 listed on October 10, 2026. Store screenshots and public mobile screenshots inform the conversation shell, rounded composer, and outline controls; no ChatGPT branding or unsupported voice controls are included.
- Mobile: a full-height conversation with a 64px header, independently scrolling messages, and an anchored composer. The conversation drawer opens modally below 821px.
- Desktop: a 288px conversation sidebar and the same conversation surface. Text is bounded to 736px and the composer to 768px.
- Browser and settings open in accessible dialogs, presented as bottom sheets on phones. Browser captures preserve their source colors and aspect ratio. Conversation deletion requires explicit confirmation and remains blocked during a run.
- Browser tab lists update automatically after a two-second delay between completed requests. Selected previews use a one-second delay, visible thumbnails ten seconds, and connection settings five seconds. Requests never overlap within a refresh loop, time out after sixty seconds, and retry automatically. Returning to the app or reconnecting the network triggers an immediate update. No refresh or pause controls are shown; hidden screens stop polling. Closed and sleeping tabs follow the latest tab list rather than stale selection data.
- The visible viewport controls shell height so the composer stays above a mobile keyboard. Safe-area insets cover the header, composer, and drawers.
- Home-screen apps render the canvas beneath the iOS status bar. Theme changes update the page background, color scheme, and browser theme color together so the status bar follows the selected appearance.

## Tokens and typography

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | `#ffffff` | `#212121` |
| Sidebar / composer / code | `#f7f7f7` | `#2f2f2f` |
| User bubble | `#f1f1f1` | `#303030` |
| Text | `#171717` | `#f3f3f3` |
| Secondary text | `#666666` | `#b4b4b4` |
| Border | `#e9e9e9` | `#414141` |
| Hover | `#ededed` | `#3b3b3b` |
| Error | `#b42318` | `#ff9b91` |
| Composer / dialog radius | `28px` | `28px` |
| User bubble radius | `24px` | `24px` |

Wanted Sans is the only selectable or loaded typeface, including UI controls and code. Fonts load through the existing same-origin proxy. Body text uses 16px / 1.7; user messages use 16px / 1.55; header text uses 19px, weight 650. Inputs start at 16px and scale with the text-size setting to avoid iOS focus zoom.

`global.css` owns the light/dark color values, reset, and Markdown descendant rules. `web/src/tokens.stylex.ts` exposes these colors and typography to component styles. StyleX extracts component styles at build time.

Settings → Appearance exposes a Dark mode switch and text sizes from 100% to 200%. Text uses relative units so this preference scales conversation content, controls, and code. Light is the default; an explicit choice persists in browser storage and applies before React mounts. The theme covers conversations, drawers, dialogs, code highlighting, and toasts. Images, browser captures, and rendered diagrams retain their source colors; diagrams use a light backing for contrast.

## Controls and states

- Outline icons use Lucide with consistent rounded strokes, usually 1.8px. The menu uses two horizontal lines; the new-chat control uses a square and pencil. The black send control has a white upward arrow. During a response, an empty composer shows Stop; entering a follow-up exposes a queue arrow alongside Stop.
- Follow-ups appear as right-aligned user bubbles inside the conversation, with a queue icon, Queued label, and ellipsis menu. The menu shows Edit message, Steer instead, and Cancel message; an idle response uses Send now instead of Steer instead. Editing holds delivery until Save or Cancel. There is one editor at a time, and the composer has no separate steering control or queue cards.
- Existing conversations expose an ellipsis button in the toolbar. Its session sheet shows the title, session ID, and canonical conversation link, with actions to share the session or copy its link or ID. Sharing uses the device share sheet when available and copies the title, ID, and link otherwise. Canceling device sharing leaves the session sheet available. Links retain the server's existing authentication requirements; sharing does not publish a conversation or include an access token. Unsaved new conversations have no session menu.
- No ornamental sparkles, robot marks, promotional cards, or artificial metrics appear in the interface.
- Buttons expose accessible names without visible focus outlines. Scrollable conversation, code, and table regions support keyboard navigation. Dialogs trap focus and support Escape. Motion animates the sheet, drawer, backdrop, toast, attachment, and button transitions. Phone sheets close by dragging their handle downward; content scrolling does not start a drag. Exiting dialogs keep their native focus trap until the transition ends and restore focus to a connected trigger. Reduced-motion settings disable smooth scrolling and dragging and shorten opacity transitions.
- General text and URLs wrap at any character. Tables and fenced code scroll within their own region and do not widen the app.
- Auto-scroll follows incoming content while the reader is near the bottom. Scrolling upward preserves the reading position and shows a jump-to-latest control. Sending a new message returns to the latest turn.
- Attachments show upload state, can be removed, and remain recoverable when a response fails to start. Resized PNG/WebP images preserve transparency; GIF files keep their animation.
- Toasts report copy, authentication, upload, deletion, and connection errors. Remote errors map to fixed, actionable messages; CLI output, update notices, account details, and unknown exception text remain outside the UI. Up to three toasts fit in a scrollable stack without truncating their text. Errors stay until dismissed; success notices expire after ten seconds and pause while hovered or focused. Errors never erase the user's draft. Settings confirms browser connectivity with a fresh tab query rather than process liveness.
- Answer citations appear as numbered source links using source metadata from the original tool result. Citation tags remain literal inside code examples; unresolved references preserve their body without inventing a URL. Copies include readable Markdown links instead of internal XML tags.

## Conversation lifecycle

Explicitly opening a conversation persists its ID. Initial load restores the saved conversation, including when a browser/settings panel is open; without a saved selection it opens the latest conversation. Explicit New chat persists the empty conversation choice until a message creates a session or the user selects an existing conversation.

The drawer orders conversations by the last user or assistant message timestamp, newest first, with the session ID as a stable tie-breaker. Opening a conversation, changing daemon metadata, or touching its log file does not promote it. Incoming messages update the order immediately; older list responses cannot undo newer message activity. Date groups and pagination use this same activity time, including equal-time page boundaries. Sessions without timestamped messages use the log's modification time; newly created sessions without a log use their reported update time.

Conversation lists also synchronize automatically every five seconds while the app is visible, and immediately when it becomes visible again or the network reconnects. Automatic retry failures do not generate repeated toasts. The sidebar has no refresh control.

Each send has a request ID. Late responses cannot reselect a conversation after navigation. The bridge keeps a bounded request-status registry so reconnecting clients can recover a delivery without sending the prompt twice. Reconnection reloads canonical messages before subscribing to the stream. Polling also recovers completion when a stream event is missed.

The bridge persists follow-up queues per conversation and delivers them in insertion order after the current response ends. Queues synchronize across clients through events and automatic polling. Stop pauses automatic delivery without removing queued messages; Resume continues it. Editing renews a delivery hold while the editor is open. Failed or interrupted delivery stays visible for recovery, and accepted message IDs prevent duplicate delivery. Steering uses Aside's native running-session input rather than stopping and restarting the response.

The bridge reads Aside CLI raw `text_delta` events through its hidden `--log-dump` option and sends cumulative `msg.delta` snapshots before execution finishes. These are real response fragments, with no simulated typing of saved messages. Each snapshot identifies its session, run, assistant stream, revision, and numeric timestamp or response ID. A finalized canonical message replaces the matching live answer; late snapshots cannot duplicate it. Reconnection receives the latest snapshot, and stopping a run also rejects later frames from that run. The temporary dump has owner-only permissions and is removed when execution ends.

## Verification

Use the production build as well as the development server. Verify 320px, 375px, 390px, 430px, desktop, and short landscape viewports. Exercise new conversations, continuation, restored selections, search, drawer navigation, browser preview, long draft input, long unbroken responses, tables/code, disclosure state, copy feedback, attachment removal, and confirmation cancellation.
