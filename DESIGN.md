---
name: SeaDex Companion
description: Existing visual system for the self-hosted anime library companion
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
typography:
  display:
    fontFamily: 'Manrope, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "clamp(2rem, 3vw, 3rem)"
    fontWeight: 800
    lineHeight: 1.12
    letterSpacing: "-0.025em"
  headline:
    fontFamily: 'Manrope, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "30px"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: 'Manrope, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: "-0.012em"
  body:
    fontFamily: 'Manrope, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "14px"
    lineHeight: 1.45
  label:
    fontFamily: 'Manrope, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "12px"
    fontWeight: 600
rounded:
  card: "14px"
  control: "10px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  2xl: "16px"
spacing:
  control-x: "16px"
  control-y: "10px"
  card-padding: "14px"
  mobile-card-padding: "12px"
  grid-gap: "16px"
  desktop-gutter: "32px"
  intermediate-gutter: "24px"
  mobile-gutter: "16px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-library-scan:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.accent-bright}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 14px"
  card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
  navigation-item:
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "12px"
  season-badge:
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "4px 8px"
  status-banner:
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "4.8px"
  library-toolbar:
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.2xl}"
    padding: "10px"
---

# Design System: SeaDex Companion

<!-- impeccable:design-map -->
Name: SeaDex Companion
Colors: primary: accent #4f8cff; neutral: canvas #0b0e14; semantic: good #34d399; primary: accent-bright #6ea1ff; neutral: canvas-soft #0f131c; neutral: panel #141a26; neutral: panel-raised #1a2231 (+10 more in the sidecar)
Fonts: Manrope (display, headline, title, body, label)
Spacing: control-x 16px, control-y 10px, card-padding 14px, mobile-card-padding 12px, grid-gap 16px, desktop-gutter 32px, intermediate-gutter 24px, mobile-gutter 16px
Radius: card 14px, control 10px, md 6px, lg 8px, xl 12px, 2xl 16px
North Star: "The Library Control Room"
Don't:
- Don't reintroduce the removed library table or view switcher.
- Don't imply that an uncertain match is confirmed or hide download safeguards.
- Don't replace the established artwork, status colors, or inline download feedback during a refinement.
- Don't show zero counts while the library is still loading; show a dash until the first load completes.
Do:
- Do preserve source, season, cour, matching, and download state semantics.
- Do reuse the existing palette, self-hosted Manrope, and its system fallbacks.
- Do preserve keyboard focus, touch targets, responsive clearance, and reduced-motion behavior.
- Do keep every status legible without color alone: a glyph and a label, with a dashed border for not on SeaDex.
Map: frontend/src/index.css
Map: frontend/src/styles.ts
Map: .impeccable/design.json
Map: frontend/public/fonts/manrope-variable.ttf
Map: frontend/public/brands/
Full: .impeccable/design-full.md (read a section when you need its detail)
