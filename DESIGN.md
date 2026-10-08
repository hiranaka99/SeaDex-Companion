---
name: "SeaDex Companion"
description: "The Library Control Room: collection-focused, expressive, and practical."
colors:
  canvas: "#0b0e14"
  canvas-soft: "#0f131c"
  panel: "#141a26"
  panel-raised: "#1a2231"
  line: "#232c3d"
  line-strong: "#2f3b52"
  ink: "#edf2fa"
  muted: "#aab6c8"
  muted-dim: "#8e9eb5"
  accent: "#4f8cff"
  accent-bright: "#6ea1ff"
  on-accent: "#07152b"
  good: "#34d399"
  bad: "#f87171"
  warn: "#fbbf24"
  purple: "#c084fc"
  sky: "#7cc0ff"
  status-neutral: "#8b97ab"
  badge-blue: "#0d1c42"
  badge-green: "#062e20"
  badge-amber: "#3a2806"
  badge-neutral: "#1e232e"
typography:
  base:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
  headline:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "30px"
    fontWeight: 800
    lineHeight: "36px"
    letterSpacing: "-0.025em"
  headline-small:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "24px"
    fontWeight: 800
    lineHeight: "32px"
    letterSpacing: "-0.025em"
  title:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: "28px"
  body:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  caption:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
  label:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: "20px"
  eyebrow:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: "16px"
    letterSpacing: "0.14em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.7
rounded:
  md: "6px"
  lg: "8px"
  control: "10px"
  xl: "12px"
  card: "14px"
  "2xl": "16px"
  full: "9999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "7": "28px"
  "8": "32px"
  "9": "36px"
  "1.5": "6px"
  "2.5": "10px"
  "3.5": "14px"
  panel-inline: "22px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-danger:
    backgroundColor: "color-mix(in oklab, #f87171 10%, transparent)"
    textColor: "{colors.bad}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  input-field:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "10px 14px"
  navigation-item:
    textColor: "{colors.muted}"
    rounded: "{rounded.xl}"
    padding: "12px 14px"
  navigation-item-active:
    backgroundColor: "color-mix(in oklab, #4f8cff 12%, transparent)"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "12px 14px"
  status-chip:
    backgroundColor: "color-mix(in oklab, #34d399 12%, transparent)"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "4px 8px"
  panel-card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "20px 22px"
  anime-card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
  filter-chip:
    backgroundColor: "color-mix(in oklab, #4f8cff 14%, transparent)"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
---

# Design System: SeaDex Companion

## Overview

**Creative North Star: "The Library Control Room"**

SeaDex Companion is collection-focused, expressive, and practical. Its dark, rounded interface combines anime artwork with compact controls, release comparisons, and persistent status information. The collection supplies the expression; the surrounding interface makes it easy to scan and act.

Midnight Slate surfaces establish a clear hierarchy from canvas to raised panel. Signal Blue identifies primary actions and active navigation, while semantic colors distinguish ownership, availability, warnings, and download state. Depth comes from layered surfaces, ambient shadows, and selective lift and glow on actions, dialogs, and downloads.

This is a record of the incumbent implementation, not a redesign. The metaphor, mood, and palette names were confirmed by the owner. Measurements and behavior come from current source; depth and component descriptions summarize observed implementation. No visual anti-reference was supplied.

**Key Characteristics:**

- Anime artwork within a practical application shell.
- Dark tonal layers, thin borders, and gently rounded controls.
- Confident actions with compact, readable metadata.
- Stable semantic colors reinforced by labels and icons.
- Responsive navigation and visible operation feedback.

Source authority: `frontend/src/index.css`, `frontend/src/styles.ts`, `frontend/src/App.tsx`, and `frontend/src/components/`. The committed screenshots support the general direction but include older navigation; current code wins for exact behavior. The document uses the [DESIGN.md specification](https://raw.githubusercontent.com/google-labs-code/design.md/main/docs/spec.md). Its frontmatter records actual values; the companion `.impeccable/design.json` contains extensions and component previews. Generated color ramps are exploration aids, not additional application tokens.

## Colors

The palette combines Signal Blue with Midnight Slate neutrals and a functional set of status accents. Frontmatter keys preserve the source token names; alpha treatments derive from those tokens.

### Primary

- **Signal Blue** (`accent`): primary action foundations, upgrade borders, progress, and active control treatments.
- **Bright Signal Blue** (`accent-bright`): action-gradient highlights, links, selected icons, and active download text.
- **Blue Ink** (`on-accent`): dark foreground text on filled blue actions.

### Secondary

These are semantic accents, not additional brand palettes:

- **Owned Green** (`good`): best releases owned, completed downloads, and available download actions.
- **Alert Coral** (`bad`): errors, cancellation/removal controls, and ALT release markers. An ALT marker is release classification, not automatically an error.
- **Coverage Amber** (`warn`): partial coverage, matching review, missing-episode warnings, ignored items, and paused downloads.

### Tertiary

- **Release Violet** (`purple`): release tags and new-title history markers.
- **Audio Sky** (`sky`): Dual Audio release tags.

### Neutral

- **Midnight Canvas** (`canvas`): the deepest page surface.
- **Soft Midnight** (`canvas-soft`): sidebar, subdued nested content, and table headings.
- **Slate Panel** (`panel`): cards and fields.
- **Raised Slate** (`panel-raised`): modal content, floating navigation, and elevated controls.
- **Slate Line / Strong Slate Line** (`line`, `line-strong`): dividers and containment, with the stronger tone used for raised or emphasized edges.
- **Frost Ink** (`ink`): primary content.
- **Supporting Slate / Metadata Slate** (`muted`, `muted-dim`): supporting text and tertiary metadata.
- **Neutral Status Slate** (`status-neutral`): the recurring local missing-state glow color; this is a component value, not a global CSS token.

The recurring opaque badge bases (`badge-blue`, `badge-green`, `badge-amber`, `badge-neutral`) anchor readable badges over artwork. Cards apply them with partial opacity and backdrop blur. These are extracted component values, not new global variables.

**The Status Has Meaning Rule.** Preserve each context's existing semantic mapping and pair status color with readable text or an icon. A season's Not on SeaDex badge currently uses blue, while its card uses neutral styling; do not flatten these contextual distinctions.

## Typography

The interface uses the operating system's sans-serif stack for headings, controls, and prose. There is no separate display font or remote font dependency. Monospace is reserved for diagnostic output; most numeric metadata uses tabular figures within the sans-serif family.

### Hierarchy

- **Base:** inherited page text, with the global line-height recorded in frontmatter.
- **Headline:** bold page titles; the smaller headline role is used on narrow screens and account forms.
- **Title:** section and dialog headings.
- **Body:** common explanatory text and field values.
- **Caption:** supporting metadata.
- **Label:** bold action text.
- **Eyebrow:** uppercase page-category labels with expanded tracking.
- **Mono:** wrapping server log output.

These roles describe repeated usage rather than a rigid ratio. Components also contain deliberately compact metadata, including small badges and release details. The existing brand subtitle has its own uppercase tracking, and text over artwork uses a black stroke and shadow for readability.

**The Numbers Stay Aligned Rule.** Preserve tabular figures for sizes, deltas, progress, and counts. Keep uppercase and wide tracking concentrated in eyebrows, brand metadata, and short badges.

## Layout

The desktop shell fills the dynamic viewport and uses a sidebar plus a flexible content column. The sidebar is expanded at 248px and collapsed at 76px; the content pane scrolls independently. Main horizontal padding is 32px, becomes 24px at the 1200px breakpoint, and becomes 16px at the 900px breakpoint.

Below 900px, the sidebar gives way to a fixed 64px top bar and a floating 64px bottom navigation bar. Main content receives 80px top padding and 96px bottom padding. Sticky operation and filter surfaces offset beneath the top bar; mobile notifications sit above bottom navigation. These conditions follow the actual Tailwind max-breakpoint variants.

Library cards use an automatic grid with a minimum column size of 320px capped at the available width, and a 16px gap. The compact library table scrolls horizontally rather than forcing narrow columns. Page headers and action groups wrap. Scan history becomes two columns at the default 640px small breakpoint.

The sign-in shell has a maximum width of 900px with a 430px form column. Below 780px it becomes a single form column and the descriptive side panel disappears; form padding tightens below 480px. Configuration introduces its own 1100px, 600px, and 500px adaptations. Main page headlines step down below 600px.

Spacing predominantly follows Tailwind's 4px base with frequently used half-steps. The shared panel also has an explicit 22px inline padding. Preserve these observed exceptions rather than imposing a uniform grid on every detail.

## Elevation & Depth

Depth combines dark tonal layering, borders, ambient shadows, and selective lift. The page background includes faint blue and green radial illumination. Elevated operation bars, mobile navigation, and notifications combine translucent fills with backdrop blur. Card hover adds a small lift; primary actions rise subtly and strengthen their blue shadow.

### Shadow Vocabulary

- **Card / Floating Surface:** the shared card shadow supports hover cards, dialogs, operation bars, and mobile navigation.
- **Primary Action:** a blue ambient shadow strengthens on enabled hover.
- **Filter Surface:** a dark shadow separates the sticky library toolbar from content.
- **Details Dialog:** a deeper dark shadow isolates the release panel.
- **Active Download:** a status-colored glow accompanies the conic border.

Exact shadow values live in the sidecar. Default library cards do not acquire the shared hover shadow until hover; other surfaces intentionally use it at rest.

### Motion

Shared entrance animations include rise, fade, and slide-in. Buttons and fields use short state transitions; card hover uses a slightly longer transition, and navigation and shell resizing use a slower transition. Progress widths animate over 500ms.

Active download cards and their detail panels use the 2.6s rotating conic border. It follows the card's status color and is driven by download state, including tracked paused/error states where the component's active-download condition still holds. Skeletons shimmer while data loads. The details backdrop fades and blurs on opening.

**The Motion Names Work Rule.** Preserve motion's relationship to loading, activity, hover, and navigation. Honor the global reduced-motion override, which shortens animation and transition durations, limits animation iteration, and disables smooth scrolling.

## Shapes

The system favors softly rounded rectangles, thin borders, and pill-shaped metadata. Shared card and control radii are recorded alongside the repeated Tailwind corner steps in frontmatter. Navigation rows use the extra-large corner step; toolbars and major overlays commonly use the larger container step.

Badges vary with context: season labels are small rounded rectangles on library cards and pills inside release details. Artwork clips inside the card silhouette; cover thumbnails use smaller rounded corners. The account shell has an observed 22px radius. Preserve these purposeful distinctions rather than applying one radius everywhere.

Borders are generally 1px. Active download conic borders are 2px; their fill layers prevent the gradient from covering content. Hidden cards use dashed borders and subdued artwork.

## Components

### Buttons

Confident controls with clear semantic roles.

- **Primary:** the shared control radius, bold label typography, 10px vertical and 16px horizontal padding, and a downward gradient from bright accent to accent. Blue Ink text remains dark against this fill.
- **Hover:** enabled primary actions rise by 1px and strengthen their blue shadow. Disabled shared buttons use 60% opacity and a non-interactive cursor.
- **Secondary:** a Slate Panel fill, thin Slate Line border, and Frost Ink label.
- **Semantic:** download actions use green tints; cancellation/removal actions use coral tints. Confirmation dialogs use a filled blue action for ordinary confirmation and a coral treatment for dangerous confirmation.
- **Focus:** the global focus-visible outline is 2px, bright accent, and offset by 2px, except where fields supply their own focus treatment.

### Chips

Compact, legible state markers.

Status and season badges pair low-opacity semantic fills with tinted borders and explicit labels. Filter buttons use a blue selected tint, ink text, and pressed-state semantics. Release tags use Audio Sky for Dual Audio and Release Violet for other tags.

The split season badge is a signature pattern: each cour receives an equal-width segment in cour order, with hard color stops. The tooltip explains each segment. Do not replace a mixed season with a misleading single status.

### Cards / Containers

Collectible cards with practical fields and metadata.

Shared panels use the card radius, Slate Panel fill, a thin border, and 20px vertical / 22px horizontal padding. Anime cards add status-colored borders, a wide banner region, optional cover art, source/status badges, a 156px metadata body, and a footer action row. Missing-state artwork is grayscale; hidden entries receive subdued artwork and a dashed border.

The banner uses a dark overlay to keep its title readable. Card hover lifts by 4px and adds the shared shadow. Content remains grouped by season in the details view; recurring season backgrounds are tinted to match their context.

### Inputs / Fields

Practical fields that stay legible on the dark canvas.

Shared fields use Slate Panel fill, Frost Ink text, a Slate Line border, the control radius, and 10px vertical / 14px horizontal padding. Placeholder text uses Metadata Slate. Focus changes the border to Signal Blue and adds a 3px low-opacity blue ring.

Search fields add an inline outline icon and extra left padding. Labels and explanatory errors remain explicit. Form status and errors appear alongside the fields or actions; the shared field primitive itself does not define a universal error or disabled visual variant.

### Navigation

Desktop navigation uses a softly rounded row with an outline icon and a semibold label. The selected row combines a 12% blue fill, Frost Ink text, a brighter icon, and `aria-current="page"`. Unselected items use Supporting Slate; hover introduces a panel fill and brighter text.

Collapsed navigation keeps icons and label tooltips. Mobile navigation preserves all five destinations with abbreviated labels. The brand mark and account controls remain available in the mobile header.

### Dialogs & Notifications

The shared modal uses a native dialog with a dark translucent, blurred backdrop. It makes background content inert, supports Escape and backdrop dismissal when not busy, and restores focus on closing. Confirmation dialogs initially focus Cancel and keep failures visible.

Release details use a centered, scrollable panel with a maximum width of 864px and a custom backdrop transition. Notifications use raised translucent panels, semantic borders and icons, dismiss controls, and live-region semantics. These are observed mechanisms, not a claim of audited accessibility conformance.

### Active Downloads

The signature conic border and glow distinguish a card whose tracked downloads remain active. Details use a corresponding canvas-filled variant. Progress bars use rounded tracks, state-colored text, and compact tabular figures; their width transitions use the shared progress timing.

## Do's and Don'ts

### Do:

- **Do** preserve Signal Blue actions, Midnight Slate surfaces, and the existing contextual status mappings.
- **Do** keep anime artwork readable with the current overlay, title treatment, and explicit metadata.
- **Do** use shared button, field, and panel primitives before introducing local variants.
- **Do** preserve responsive navigation offsets, independently scrolling content, and horizontally scrolling compact tables.
- **Do** keep keyboard focus, state labels, and reduced-motion behavior in new components.

### Don't:

- **Don't** turn status colors into interchangeable decoration or communicate state through color alone.
- **Don't** replace the system font stack or shared token values while extending this documented incumbent system.
- **Don't** apply the active-download glow to idle cards or copy its animation into unrelated controls.
- **Don't** present generated color ramps or preview samples as implemented application tokens or real library data.
- **Don't** use older screenshots to override current source values or certify accessibility without testing.
