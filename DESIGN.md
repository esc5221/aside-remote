# Aside Remote — Linear Dark

This file defines the current app appearance. Apply it to the existing chat, conversation list, browser tabs, settings, confirmation dialogs, image viewer, and browser preview sheet.

## Reference and adaptations

- Reference: [VoltAgent's Linear DESIGN.md](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/linear.app/DESIGN.md), retrieved 2026-10-08, MIT license. This is an independent analysis, not an official Linear specification.
- Reuse its charcoal surface ladder, lavender accent, hairline borders, restrained elevation, 4px spacing scale, and small corner radii.
- Use the reference's `surface-1` as the app canvas. Its near-black marketing canvas and large marketing headings are not appropriate for this conversation app.
- Preserve the original body-font selection and saved preference, system UI fonts, and monospaced code. Keep existing Korean copy, navigation, data, and behavior.
- The generated desktop/mobile concept illustrates the surface hierarchy, compact navigation, single composer, and preview sheet. Existing app content and the exact tokens below take precedence over invented sample content or image artifacts.

## Tokens

| Role | Value |
|---|---|
| Canvas / code background | `#0f1011` |
| Sidebar / base panel | `#141516` |
| Raised panel / composer / user message | `#191a1b` |
| Hover | `#23252a` |
| Border | `#23252a` |
| Strong border | `#34343a` |
| Primary text | `#f7f8f8` |
| Secondary text | `#d0d6e0` |
| Muted text | `#8a8f98` |
| Accent | `#5e6ad2` |
| Accent hover / links | `#828fff` |
| Success / error / warning | `#30a46c` / `#e5484d` / `#d9a54e` |
| Small / medium / large corner | `6px` / `8px` / `12px` |
| Spacing | `4px`, `8px`, `12px`, `16px`, `24px`, `32px` |

Use a fixed dark color scheme regardless of the OS appearance. Native form controls, Mermaid diagrams, theme-color metadata, and native system bars must follow the same dark appearance.

## Typography and density

- Default body font: Gowun Batang with serif fallbacks. Settings expose all available body fonts, including optional Wanted Sans, and preserve the selected font across reloads. Load webfonts through the existing same-origin font proxy.
- Use platform sans-serif fonts for UI controls and monospaced fonts for inline code, code blocks, and tool output.
- UI text: 14px / 1.5; conversation text: 15px / 1.6; sidebar heading: 18px / 1.2, weight 600; row titles: 13px, weight 600; labels and metadata: 11–12px.
- Keep code at 13px with syntax colors and its own horizontal scrolling.
- One density step: sidebar 340px → 300px; conversation gutter 16px → 12px; composer gutter 20px → 16px; row padding 12px → 8px; turn separation 34px → 24px; paragraph gap 10px → 8px.
- Do not shrink touch hit areas. Narrow screens and touch devices keep buttons and form controls at least 44px high. Text inputs stay at least 16px on touch to prevent iOS focus zoom.

## Component families

- App shell: existing desktop two-column layout above 820px; below it, a single conversation with a modal sidebar drawer. Sidebar max width 300px. Header 48px on desktop and 56px on narrow screens, plus safe-area insets.
- Header: existing menu, conversation title, browser preview, and new conversation controls. At 480px and below, show only the preview icon and retain its accessible name.
- Conversation rows: 8px corners, neutral panel, 4px vertical gap, thin lavender selected border. Equal left/right list padding, independent of scrollbar behavior.
- Chat: plain assistant text, neutral user bubble, existing markdown tables, code, tool disclosures, images, and metadata. Do not add new chat bubbles, sample responses, or synthetic cards.
- Composer: one 12px panel with 8px padding, thin border, neutral attachment control, lavender send control. Preserve independent long-input scrolling and the sticky composer. Its existing background fade is functional occlusion, not decorative imagery.
- Tabs: compact 8px rows, 72×48px preview thumbnails, ellipsized titles and URLs, existing active indicators.
- Settings: 8px fields/buttons, 12px section padding, a two-column body-font selector, existing save/auth/sleep controls.
- Preview: existing native bottom sheet, 12px corners and internal padding. Preserve real captured-page colors and aspect ratio; do not tint the captured browser image. Preserve pause, refresh, close, agent instruction, and tab actions.
- Delete confirmation: 12px dialog, 16px padding, wrapped long title, bounded viewport height and internal scrolling. Keep the destructive warning and explicit confirmation.
- Image viewer: existing dark full-screen overlay with contained image and close interaction.

## Icons

- Use official Remix Icon 4.9.1 SVGs for all functional UI icons. The selected symbols are bundled in `web/vendor/remixicon.symbol.svg`; their original paths and 24×24 view boxes are preserved. Use the existing `ICONS` registry and `icon()` renderer when adding or changing an icon.
- Use line variants, except the solid stop control. Base icons are 16px; icon-only header, composer, and preview-dismiss controls use 20px. Inherit the control's text color and center icons with a 6px gap beside labels.
- Preserve the existing 44px touch targets. Give icon-only controls explicit accessible names, and hide decorative SVGs from assistive technology. Keep text labels for preview actions, settings actions, and navigation.
- Disclosure arrows rotate only when their own details element is open. Loading icons rotate, except under reduced motion. Pause/resume and copy/copied states retain their matching Remix icons after updates.
- Keep Aside's brand/app icons and real website favicons. Remix icons serve UI actions rather than app identity, as required by the bundled Remix Icon License v1.0. Use Remix's globe icon only for a missing website favicon.
- Serve the SVG sprite from the app's own origin. Do not add an icon font or a third-party runtime dependency.

## States, motion, and verification

- Lavender keyboard focus ring; neutral hover; muted disabled state; distinct success/error states. Avoid decorative gradients or shadows on ordinary rows and panels.
- Short 100–150ms transitions; disable nonessential motion when reduced motion is requested.
- Safe-area spacing applies on all four edges. Lists and chat scroll independently. Tables, code, tool output, and long input may scroll inside their own region without widening the page.
- Verify actual browser viewports 320px, 375px, 430px, desktop, and short landscape. Exercise each navigation view, filters, long text, disclosures, preview, image zoom, and confirmation cancellation. Do not send prompts, close real tabs, or delete real conversations merely to test styling.

Reference copyright: Copyright (c) 2026 VoltAgent. MIT license accompanies the downloaded source reference.
