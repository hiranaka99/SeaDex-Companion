# Follow-up UI and UX audit

Date: 2026-10-08. Impeccable audit of the current application after the approved five-pass refinement. This review changes no application code. PRODUCT.md and DESIGN.md remain authoritative.

Status: all nine findings were subsequently approved and addressed. See [the implementation and final audit](ui-ux-follow-up-implementation.md). The findings and 14/20 score below retain the pre-implementation baseline.

## Implementation integrity verdict

**Pass.** The interface expresses a coherent collection-management system: anime artwork, release comparisons, season/cour distinctions, matching review, scoped download estimates, and explicit removal consequences. Signal Blue / Midnight Slate and the existing components remain appropriate. The Impeccable detector (`detect --json frontend/src`) completed with exit 0 and returned `[]`.

The visual observations below identify common template-like treatments, not evidence that AI authored the interface. A clean detector result does not establish accessibility or usability. There is no reason to replace the design identity or introduce dependencies.

## Health and priority

| Dimension | Score | Main observation |
|---|---:|---|
| Accessibility | 3/4 | Labels and focus are established; enlarged text needs more resilient navigation and card layouts. |
| Performance | 2/4 | A 1,000-title fixture mounts approximately 36,000 DOM elements; banners have no explicit lazy-loading mechanism. |
| Responsive design | 2/4 | Long errors, cancellation metadata, short screens, and enlarged text expose additional weaknesses. |
| Theming | 3/4 | Strong token foundation; some isolated surface and effect literals remain, including the log surface. |
| Implementation integrity | 4/4 | Product-specific content and behavior; no detector findings. |
| **Total** | **14/20 — Good** | Address resilience before further visual polish. |

This is broader coverage than the previous 17/20 implementation audit, which explicitly excluded text enlargement and large-library profiling. The score change reflects newly exercised cases, not a code regression. Scores are engineering judgments, not conformance certification.

**Nine findings: P0 0, P1 1, P2 6, P3 2.** Eight are additional findings; one is the previously deferred log-follow behavior.

## Prioritized findings

### 1. P1 — Long operation errors obscure the application and its recovery surface

- **Location:** `frontend/src/components/OperationCenter.tsx:34`, error copy at line 43; `frontend/src/App.tsx:241`.
- **Category:** Responsive design / accessibility of recovery.
- **Evidence:** At 390×844, a realistic multi-path synthetic error produced a 784px operation panel. After scrolling the main pane by 900px, the panel remained pinned at y64 and covered the library. Switching to Configuration preserved the same obstruction above its save footer. At 844×390, the operation panel was 332px tall, exceeding the useful space between navigation surfaces.
- **Impact:** Reading backend diagnostics can prevent users from reaching the integration fields needed to correct the failure. Wrapping alone is insufficient because the whole message is sticky.
- **Recommendation:** Keep a compact summary and recovery actions visible; put full diagnostics in an expandable, height-bounded area. Allow a tall panel to leave the sticky position on short screens. Preserve every error detail and existing retry/configuration action.
- **Suggested command:** `$impeccable harden`, then `$impeccable adapt`.

### 2. P2 — Cancellation metadata still overflows on narrow screens

- **Location:** `frontend/src/components/BulkCancelDialog.tsx:82`, particularly the metadata flex row at line 86.
- **Category:** Responsive design / destructive-action clarity.
- **Evidence:** At 320×700, an unbroken long release-group name expanded the cancellation body from a 276px client width to a 1,092px scroll width. The release size and subsequent metadata moved outside the visible area. The main document itself did not overflow.
- **Impact:** Users must scroll sideways inside a removal dialog to verify what they are cancelling. Document-width checks alone miss this problem.
- **Recommendation:** Apply the established release-identity wrapping treatment here, with shrinkable text and a separate readable size/count row. Keep file deletion warnings and the default file-preservation behavior.
- **Suggested command:** `$impeccable adapt`.

### 3. P2 — Short screens devote too much height to fixed chrome and nested scrolling

- **Location:** `frontend/src/App.tsx:229`, configuration footer at line 283; `frontend/src/components/LogTab.tsx:31`; `frontend/src/components/TopBar.tsx:101`.
- **Category:** Responsive design / information density.
- **Evidence:** At 844×390, Configuration's content pane ends at y235. The fixed top header, save area, and bottom navigation leave about 171px of unobstructed form-reading space. The log's 360px minimum internal height creates nested scrolling; its rows initially continue behind the bottom navigation.
- **Impact:** Landscape phone use and short desktop windows require excessive scrolling and make the active scroll region less obvious.
- **Recommendation:** Add a short-height layout using existing tokens: compact the configuration save area and unnecessary heading gaps, and size the log to available space with one clear scroll owner. Validate native browser keyboard resizing separately. Safe-area insets are absent from the mobile shell; verify them on a physical device before choosing an inset adjustment.
- **Suggested command:** `$impeccable adapt`, then `$impeccable layout`.

### 4. P2 — Text enlargement exposes navigation collisions and clipped card controls

- **Location:** `frontend/src/components/TopBar.tsx:106`; `frontend/src/components/Card.tsx:505` and its card footer.
- **Category:** Accessibility / responsive design.
- **Evidence:** At 390×844 with the root font enlarged from 16px to 32px, mobile navigation labels overlap, bulk-action text exceeds its buttons, and card footers have scroll widths greater than their available widths. The active-download body uses a constrained height while its children grow.
- **Impact:** Larger-text users lose label legibility and control clarity.
- **Recommendation:** Allow footer/action wrapping and content-driven card heights; use a navigation arrangement that keeps all five destinations legible when text grows. Preserve visible labels and existing navigation behavior.
- **Standard:** Relevant to WCAG 1.4.4 and 1.4.10, but this synthetic root-font check is not a real browser-zoom or OS text-size conformance test. Validate those before claiming a violation or a fix.
- **Suggested command:** `$impeccable adapt`, then `$impeccable typeset`.

### 5. P2 — Filter state and toolbar density need clearer presentation

- **Location:** `frontend/src/components/AnimeTab.tsx:251`, mobile disclosure at line 256 and desktop status strip immediately below it.
- **Category:** Navigation / information hierarchy.
- **Evidence:** A source selection remains active after closing “View & filters,” but the collapsed button gives no active-state summary. Source, hidden-only mode, and sort can be out of sight together. On a 1440px viewport with the expanded sidebar and single-digit counts, the desktop status strip needs horizontal scrolling: 1,118px content inside 1,102px. At landscape width, the difference is larger.
- **Impact:** A returning user can misread a filtered collection as the full library; the desktop toolbar spends attention on a dense row of repeated labels and counts.
- **Recommendation:** Show a compact active-filter summary and an accessible clear/reset action outside the disclosure. Let desktop status controls wrap or adjust grouping while retaining every existing status and count. Keep the intentionally scrollable data table.
- **Suggested command:** `$impeccable clarify`, then `$impeccable layout`.

### 6. P2 — New log entries move users away from what they are reading

- **Location:** `frontend/src/components/LogTab.tsx:30`.
- **Category:** Usability / diagnostic reading.
- **Evidence:** After setting the log scroll position to 0, adding one fixture line caused the next refresh to move it to 1,731px.
- **Impact:** Investigating an older error competes with automatic following.
- **Recommendation:** Follow while the reader is near the bottom; pause when they scroll away, with an explicit “Follow live output” control. This remains the separately deferred behavior change from the previous audit and requires inclusion in the next approved scope.
- **Suggested command:** `$impeccable harden`.

### 7. P2 — Large collections need bounded rendering and artwork loading

- **Location:** `frontend/src/components/AnimeTab.tsx:273`; banner at `frontend/src/components/Card.tsx:482`; result lookup at `frontend/src/components/HistoryTab.tsx:33`.
- **Category:** Performance / collection usability.
- **Evidence:** A 1,000-title fixture produced 36,212 DOM elements. Both card and table views map the complete collection into mounted Card components. Card banners are CSS background images with no explicit lazy-loading mechanism; the small poster images already use lazy loading. History performs up to two linear result searches for each rendered change.
- **Impact:** DOM size, initial work, artwork requests, and history lookup cost grow with a collector's library.
- **Recommendation:** Profile a realistic image-bearing collection first. Consider incremental presentation or bounded rendering without interrupting download tracking; reuse native lazy-loading where possible and index history lookups by key with the current fallback semantics.
- **Limit:** The large fixture had no artwork and no runtime exceptions. DOM size is measured; actual network waste and slow-frame severity were not measured. Do not infer a specific speed improvement.
- **Suggested command:** `$impeccable optimize`.

### 8. P3 — Repeated visual emphasis gives some surfaces a template-like feel

- **Location:** Configuration sections at `frontend/src/components/ConfigTab.tsx:217`; Library header at `frontend/src/components/AnimeTab.tsx:242`; History at `frontend/src/components/HistoryTab.tsx:39`; release detail structure in `frontend/src/components/Card.tsx:535` onward.
- **Category:** Visual judgment / hierarchy / typography.
- **Evidence:** Configuration repeatedly uses rounded section panels, inset rows, icon tiles, and status pills. Release detail places bordered name labels inside bordered release rows inside bordered season sections. Small labels and metadata frequently share bold or extra-bold weight. “Overview,” “Activity,” “Settings,” and “Diagnostics” add a second naming layer above already descriptive page titles.
- **Impact:** Borders and bold text compete with the release recommendation, ownership state, size, and next action. Repetition makes unrelated sections look equally important.
- **Recommendation:** Remove redundant wrappers selectively, use existing dividers and spacing to group related content, and reserve stronger weight for the decision-bearing information. Reduce eyebrows where they repeat the title's meaning. Review the spacious one-season card metadata area, while preserving artwork-led browsing and collection alignment.
- **Context:** Rounded panels, semantic pills, primary-action gradients, and functional download glow are documented design choices. Keep them where they communicate hierarchy or state. Empty artwork in synthetic fixtures is not evidence that real artwork should be removed.
- **Suggested command:** `$impeccable distill`, then `$impeccable typeset`.

### 9. P3 — Touch-target coverage remains uneven

- **Location:** Mobile logout at `frontend/src/components/TopBar.tsx:103`; bulk cancellation “Check/Uncheck all” at `frontend/src/components/BulkCancelDialog.tsx:76`; log filter buttons at `frontend/src/components/LogTab.tsx:31`.
- **Category:** Responsive design / accessibility ergonomics.
- **Evidence:** These controls do not consistently use the existing touch-target treatment. The mobile logout remains 36×36px; the cancellation and log controls are compact.
- **Impact:** Occasional actions require more precise touch than adjacent controls.
- **Recommendation:** Extend the existing touch-target utility or equivalent hit area without inflating desktop density.
- **Standard:** 44×44px is an ergonomic target here. These measurements alone do not establish a WCAG AA failure; AA's minimum target requirement and spacing exceptions differ.
- **Suggested command:** `$impeccable adapt`, then `$impeccable polish`.

## Patterns and strengths to preserve

The recurring technical gap is checking document overflow without checking inner flex rows, sticky height, or enlarged text. The recurring visual opportunity is reducing repeated containers and emphasis while retaining semantic status cues.

Keep the accurate domain language, status explanations, visible form labels, native modal isolation, contextual download actions, credential handling, low-space acknowledgement, and clear file-deletion consequences. Shared download polling already coalesces requests; this review does not recommend replacing it with per-card timers. Collapsed sidebar destinations have accessible names from their title attributes in Edge's accessibility tree; they are not unnamed buttons. Reduced motion preserves visible state and progress. A single intentional dark theme is not a missing-light-mode defect.

## Evidence and limits

Current source and all main routes were reviewed alongside the previous implementation captures. New isolated browser fixtures exercised 320×700 cancellation, 390×844 mobile state and text enlargement, 844×390 landscape screens, 1440×1000 desktop controls, multi-path operation errors, log refresh, collapsed navigation accessibility names, and a 1,000-title collection. The final browser run produced 16 evidence records and zero unhandled runtime exceptions.

Artifacts: ignored `node_modules/.cache/impeccable/follow-up-audit/`, including `evidence.json` and screenshots. The temporary harness derives from the existing dependency-free browser smoke harness; it does not modify that committed harness. An initial harness attempt used desktop navigation labels on mobile; the fixture script was corrected before the final captures. Browser and fixture server cleanup completed. No real configuration writes, scans, downloads, cancellation, or removal occurred.

Physical devices, Safari/Firefox, complete screen-reader workflows, real browser zoom, image-bearing network profiling, and frame-time profiling remain untested. Toast live-region verbosity and animated-border paint cost merit targeted verification rather than an unverified defect claim. No full test rerun was needed for this report-only change; prior implementation test results are recorded in `docs/ui-ux-audit.md`.

## Recommended command sequence

1. `$impeccable harden`: bound operation diagnostics; include log-follow behavior only in approved scope.
2. `$impeccable adapt`: cancellation wrapping, short screens, enlarged text, and remaining touch hit areas.
3. `$impeccable clarify` and `$impeccable layout`: visible filter state and toolbar grouping.
4. `$impeccable optimize`: profile large collections, then address measured rendering and artwork costs.
5. `$impeccable distill` and `$impeccable typeset`: reduce decorative nesting and competing typographic emphasis.
6. `$impeccable audit`: repeat edge cases and validate actual zoom/device behavior after fixes.
7. `$impeccable polish`: finish alignment, spacing, and visual consistency.

These commands can be run one at a time, all together, or in another approved order. Re-run `$impeccable audit` after fixes to reassess the score.
