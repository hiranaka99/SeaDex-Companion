---
target: entire application UI and UX
total_score: 26
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 2
target_identity: "file:C:\\Coding\\SeaDex Companion\\frontend\\src\\App.tsx"
target_fingerprint: "sha256:f81ddae90af8e91a3f8d820aab2d9a474f885493a609f24e99b1c997f03d8368"
target_path: "C:\\Coding\\SeaDex Companion\\frontend\\src\\App.tsx"
timestamp: 2026-10-08T16-32-56Z
slug: frontend-src-app-tsx
closed: true
---
Method: dual-agent (A: /root/design_review · B: /root/evidence_review)

**Prioritize mobile readability and task hierarchy.** The application already has a coherent, product-specific identity. Preserve The Library Control Room, Signal Blue / Midnight Slate, artwork, split season badges, and meaningful download animation. No application code has changed.

The review covered all five destinations, sign-in/setup, configuration, release details, bulk review, mapping, and removal dialogs. Source inspection was paired with current desktop (1440px), mobile (390px), and targeted narrow-screen (320px) renders using isolated sample data.

**Prioritized improvement plan**

1. **P1 — Repair mobile configuration and release comparisons.** Configuration's floating save bar covers section headings and explanatory content; test/clear buttons also squeeze adjacent text into narrow columns. In release stress tests, group names become almost unreadable and tag containers collapse to zero width. Download filenames similarly lose space to controls. Reflow headings/actions onto separate mobile rows, reserve scrolling clearance for the save surface and navigation, and separate release identity/tags from size/actions. Keep every comparison datum and existing action. Commands: `adapt`, then scoped `layout`, targeting ConfigTab, Card, DownloadsTab, and the mobile shell. Completion: readable long groups, filenames, tags, and section headings at 320/390px; desktop alignment preserved. Two major findings, no confirmed P0 blocker.

2. **P2 — Make status explanations and small controls accessible.** Season/cour explanations rely on hover titles. Configuration Clear links are approximately 26×16px; bulk's standalone inclusion checkbox is 14×14px. Add keyboard/touch-accessible explanations while retaining split badges, improve hit areas, give repeated actions title/season context, and add a persistent mapping-search label. Its placeholder currently provides an accessible name, so it is not unnamed. Commands: `harden` and `clarify` for SeasonBadge, transfer controls, bulk selection, and mapping. Completion: keyboard traversal, focus visibility, accessible names/state, and touch operation verified. Small visual checkboxes with large clickable labels should remain compact. Assess WCAG 2.2 target spacing exceptions rather than treating every sub-44px control as an automatic failure.

3. **P2 — Reduce the height of mobile controls and summaries.** Seven Library filters and ancillary controls push anime titles below the initial narrow viewport. Five equally weighted bulk metrics delay release choices. The bulk dialog scrolls correctly; its issue is hierarchy, not missing content. Compact summary tiles into aligned rows, place unresolved choices earlier, and give search/status filtering stronger priority than view/source/sort controls. Keep all filters, estimates, warnings, and low-space acknowledgement. Commands: `distill` for bulk summary presentation; `layout` for the Library toolbar. Completion: the collection or release decision appears earlier without hiding safeguards.

4. **P2 — Clarify feedback and recovery.** Important operation errors truncate; temporary error toasts disappear; bulk copy attributes failures to metadata fetching even when a request failed for another reason. Removal warnings differ between surfaces. Let critical messages wrap or expand, retain relevant error details locally, use accurate outcome wording, and standardize irreversible file-deletion explanations. Clarify Hidden as a hidden-only filter and expose selected filter state programmatically. Command: `clarify` for OperationCenter, BulkDownloadDialog, DownloadsTab, and Library labels. Completion: users can understand the outcome and next step without changing request handling or deletion semantics.

5. **P3 — Refine typography, spacing, and visual emphasis.** Functional metadata at 9–10px deserves more readable existing type roles. Repeated nested panels, uppercase eyebrows, and equal-weight metric tiles sometimes flatten hierarchy. Apply consistent section gaps, label baselines, metadata emphasis, and action alignment. Simplify redundant framing where grouping remains clear. Replace generic sign-in copy with concise collection-specific wording. Commands: `typeset`, then `polish`. Completion: consistent treatment across Library, Downloads, Configuration, History, Log, auth, and dialogs, using existing components/tokens and no new dependencies.

Implementation would proceed in those bounded passes after approval. Each pass would receive a responsive and relevant interaction check. Finish with Impeccable `audit`, the project's appropriate build/checks, and fixture-based checks of existing matching, bulk, configuration, transfer, and removal flows. Report changes and remaining limitations. Preserve functionality, APIs, application logic, and PRODUCT.md / DESIGN.md throughout.

**Design specificity and generic-pattern assessment**

This feels authored for an anime collection tool: cour-aware ownership, release-group comparisons, matching uncertainty, and download preflight carry its character. The strongest opportunities are more legible comparisons and less repetitive framing. Rounded panels, blue gradients, system fonts, and activity glow are documented identity choices; removing them merely because a detector recognizes a common pattern would weaken the product.

The CLI detector returned zero findings. Browser overlays reported 162 overlapping rule occurrences across four representative views, including tiny text, clipped containers, nested cards, glow, and repeated eyebrows. They are not 162 defects: scrolling containers, documented surfaces, and some detector annotations produce contextual or false-positive warnings. Browser geometry confirmed the release-row clipping that source review had identified as a risk.

**What works**

- Collection-aware cards and season/cour badges expose meaningful domain distinctions.
- Download preflight, disk-space acknowledgement, existing-torrent handling, and Cancel-first confirmations provide useful safeguards.
- Five clear destinations, mobile navigation, preserved configuration drafts, native dialogs, and reduced-motion support give the app a solid foundation. Mapping-dialog focus containment and reduced motion passed the sampled runtime checks.

**Heuristic baseline: 26/40 — acceptable, with substantial mobile refinement needed.** This is a design-review score, not an accessibility certification. All ten heuristics apply.

| Heuristic | Score /4 | Main limitation |
|---|---:|---|
| System status | 3 | Important messages truncate |
| Match with real world | 3 | Hidden/Ignore/Cancel distinctions |
| User control and freedom | 3 | Limited immediate undo |
| Consistency and standards | 3 | Removal wording varies |
| Error prevention | 3 | Some outcome copy overstates certainty |
| Recognition rather than recall | 2 | Hover-dependent cour explanations |
| Flexibility and efficiency | 3 | Strong bulk paths; mobile controls consume space |
| Aesthetic and minimalist design | 2 | Crowded narrow-screen layouts |
| Error recovery | 2 | Incomplete or generalized failure detail |
| Help and documentation | 2 | Useful inline help; uneven status explanations |
| **Total** | **26/40** | **No confirmed P0 blocker** |

**Cognitive load and user journeys**

Three checklist weaknesses—single focus, chunking, and local choice density—produce moderate overall cognitive load, rising in mobile Library and bulk review. Grouping, progressive disclosure, and keeping comparison context visible generally work. Five navigation destinations and seven weekdays are legitimate domain choices; preserve them. The emotional weak points are configuring services on a phone and interpreting mixed bulk outcomes.

- **Casey, mobile collector:** service headings disappear under the save surface; release information crowds out; controls require precision.
- **Sam, keyboard/assistive-technology user:** cour explanations need reliable access, repeated transfer actions need context, and persistent field labels would help.
- **Alex, Sonarr/Radarr power collector:** tall controls slow collection scanning, while clipped group/tags weaken confidence in an upgrade decision.

**Smaller observations and boundaries**

Fix singular/plural bulk copy such as “1 files,” use consistent Partial terminology, and improve discovery of additional transfers in lists with hidden scrollbars. Existing text colors appear sound; verify control boundaries and individual combinations during the audit rather than recoloring the palette wholesale. Consider log auto-scroll while reading older entries separately, because changing that behavior extends beyond visual refinement. Runtime checks were representative, not exhaustive screen-reader, zoom, or accessibility conformance testing.

Approve the full five-pass plan, approve only the P1 mobile fixes first, or revise the scope?
