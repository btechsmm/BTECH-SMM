## Design Concept
This deck serves as a professional corporate training guide for a SaaS ambassador program. The visual anchor combines Apple's Developer Human Interface Guidelines (for its whitespace-first clarity and strict UI focus) with the structural rigor of the Swiss International Style (for objective, grid-based information delivery). The color story is steady, conservative, and cool-toned, anchoring on the brand's deep navy. To avoid the generic "tech startup" cliche of neon blue gradients on dark backgrounds, we commit to a flat, mature palette: pure white backgrounds (`#FFFFFF`) to maximize legibility and mimic a clean software environment, supported by deep navy text and pale blue tinted cards to structure information without overwhelming the eye. The typographic voice relies on a single, crisp sans-serif family to project an authoritative, modern, and highly approachable instructional tone.

## Visual Language
- **Imagery:** Supporting role only. Strictly utilize the user-provided screenshot, cropped and scaled to highlight specific UI zones (e.g., referral link, earnings panel). No decorative or metaphorical stock photography is permitted. 
- **Containers:** Card-based. UI segments, warnings, and step-by-step instructions must be housed in subtle, pale blue rounded cards (`border-radius: 8px`) to visually separate them from the main instructional text.
- **Icons:** Solid Font Awesome icons, used minimally and strictly as functional signifiers for UI actions (e.g., link, copy, share, lock).
- **Dataviz:** Tables must use pure white backgrounds with pale blue header rows (`#E0E7FF`) and deep navy text (`#0A192F`). Standard grid lines use the divider token.
- **Motif:** A subtle 4px deep navy top border (`#0A192F`) on all pale blue instructional cards and main content blocks, reinforcing the structural SaaS UI aesthetic.

## Layout Directives
- **Global:** Page margins at 60px. Left-aligned typography for all instructional text. Page numbers placed at the bottom right. The motif (4px top border) applies to all tinted content containers.
- **Cover:** Centered layout, deep navy background, white text, generous top and bottom margins.
- **Table of Contents:** A multi-column grid of softly tinted cards representing sections.
- **Section Dividers:** Deep navy background with a pale blue accent line, left-aligned large typography.
- **Closing:** Echoes the cover with a deep navy background, centering the final message and support contacts.
- **Slide Map:**

| id | pattern | image | density |
|---|---|---|---|
| welcome | cover centered | none | low |
| portal_overview | two-column ui breakdown | supporting | medium |
| referral_link | focus card with steps | supporting | medium |
| referral_journey | process flow diagram | none | medium |
| earnings | four-grid metric cards | supporting | high |
| referral_records | data table view | supporting | high |
| responsible_sharing | dos and donts lists | none | medium |
| support_security | text left icon right | none | low |
| closing | cover echo centered | none | low |

## Design Tokens
| token | hex | usage |
|---|---|---|
| primary | #0A192F | Cover backgrounds, primary headings, motif top border |
| brand-blue | #1D4ED8 | Interactive elements, UI button highlights, accents |
| bg-page | #FFFFFF | Default slide background for high legibility |
| bg-tint | #E0E7FF | Background for instructional cards, table headers |
| text-main | #1E293B | Primary body copy |
| text-muted | #64748B | Disclaimers, captions, secondary labels |
| divider | #CBD5E1 | Table borders, subtle section lines |

| role | family | size (px) | applies_to |
|---|---|---|---|
| display | Inter | 48 | Cover and closing titles |
| heading | Inter | 32 | Slide titles |
| body | Inter | 18 | Main instructional text, list items |
| caption | Inter | 14 | UI labels, image annotations, disclaimers |

## Guardrails
- **Forbidden:** Do not use neon blue or electric cyan gradients.
- **Forbidden:** Do not invent data, referral commissions, or UI elements not present in the provided screenshot.
- **Forbidden:** Do not use CSS animations or transition effects.
- **Forbidden:** Do not use dark backgrounds on instructional content slides (only covers/closing).
- **Size floors:** body ≥18px, caption ≥14px, table ≥14px.
