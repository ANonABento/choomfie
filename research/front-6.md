# Front 6 — UI design (spacing, type, colour, hierarchy)

Accessed 2026-11-08. Primary sources only: Refactoring UI (Wathan & Schoger), W3C WCAG, Material 3, Tailwind docs, Butterick, Apple HIG.

## Answer
Pick constrained scales up front (spacing, type, colour shades), build hierarchy with weight/colour before size, start with too much whitespace, and check contrast with the WCAG formula. Generic look comes from defaults (system blue, centred hero, equal-weight everything, grey-on-colour text); the checklist below targets those.

## Core rules
Each: rule — reason — source.

### Spacing
- Use a fixed spacing scale (e.g. 4,8,12,16,24,32,48,64,96,128 px); never pick ad-hoc values. — Removes decision fatigue; adjacent values ≥ ~25% apart so differences are visible. — https://www.refactoringui.com/ ; https://tailwindcss.com/docs/theme
- Start with too much whitespace, then remove. — Cramped is the default failure; generous space reads as designed. — https://www.refactoringui.com/
- Space between groups must be larger than space inside groups. — Proximity defines grouping; ambiguous gaps blur structure. — https://www.refactoringui.com/
- Don't stretch content to fill the screen; cap text columns (~45–90 chars). — Long lines hurt reading. — https://practicaltypography.com/line-length.html
- Use a minimum hit target of 44×44 pt (24×24 CSS px is the WCAG 2.2 AA floor). — Touch accuracy. — https://developer.apple.com/design/human-interface-guidelines/accessibility ; https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html

### Type
- Define a hand-picked type scale (e.g. 12,14,16,18,20,24,30,36,48,60,72 px), not a strict modular ratio. — Ratios give fractional, awkward sizes at small end. — https://www.refactoringui.com/ ; https://tailwindcss.com/docs/font-size
- Use px/rem sizes, not em, inside components. — Nested em compounds and drifts off-scale. — https://www.refactoringui.com/
- Body text 16px minimum on web; line-height ~1.5 for body, tighter (1.1–1.25) for large headings. — Line-height should fall as size rises. — https://practicaltypography.com/line-spacing.html ; https://www.refactoringui.com/
- Use at most 2 families; pair by role (one for UI/body, optional display). Use 2–3 weights (400/500–600/700), never <400 for UI text. — Thin weights fail at small sizes. — https://www.refactoringui.com/
- Left-align body text; centre only short (≤2–3 line) blocks. — Ragged centred paragraphs are hard to scan. — https://practicaltypography.com/centered-text.html
- Align mixed-size text on the baseline, not the centre. — Looks aligned to the eye. — https://www.refactoringui.com/
- Tighten letter-spacing on large headings; widen on ALL-CAPS small labels. — https://practicaltypography.com/letterspacing.html
- Name type tokens by role (display/headline/title/body/label × L/M/S). — Role tokens survive redesigns. — https://m3.material.io/styles/typography/type-scale-tokens

### Colour
- Define colours up front: 1 primary, 1–2 accents, semantic (red/amber/green/blue), and 8–10 greys, each as 9–10 shades (50–900). — Lighter/darker variants are needed everywhere; generating ad hoc yields mush. — https://www.refactoringui.com/ ; https://tailwindcss.com/docs/colors
- Use HSL/OKLCH to build shades; rotate hue slightly toward a bright hue (60/180/300) to lighten, toward dark (0/120/240) to darken, instead of only changing lightness. — Keeps shades saturated, not washed out. — https://www.refactoringui.com/ ; https://evilmartians.com/chronicles/oklch-in-css-why-quit-rgb-hsl
- Tint greys (slight blue = cool, yellow/orange = warm). — Pure grey looks dead. — https://www.refactoringui.com/
- Never put grey text on a coloured background; use a lighter/darker tint of the background hue. — Grey looks dirty on colour. — https://www.refactoringui.com/
- Body text contrast ≥ 4.5:1, large text (≥24px or ≥18.66px bold) and UI components ≥ 3:1. — WCAG 2.2 AA. — https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html ; https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
- Don't use colour alone to convey state; add icon/text. — https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html
- For white text on a coloured button that fails contrast, flip it: dark text on a light tint. — https://www.refactoringui.com/

### Hierarchy
- Emphasise by de-emphasising: mute secondary text (grey/lighter weight) before enlarging primary. — Size alone flattens; weight+colour gives 3 levels without huge sizes. — https://www.refactoringui.com/
- Use ~3 text colours: dark (primary), mid-grey (secondary), light-grey (tertiary). — https://www.refactoringui.com/
- Labels are a last resort; show `value` with context (e.g. "12 left in stock" not "Stock: 12"). — https://www.refactoringui.com/
- One primary action per view: solid primary, outline/soft secondary, link-style tertiary; destructive isn't automatically red-big unless it's the primary action. — https://www.refactoringui.com/
- Separate with spacing, background tint or shadow before borders. — Too many borders = busy. — https://www.refactoringui.com/
- Use a small elevation set (≈5 shadows); shadow = height, use two-part shadows (tight dark + large soft). — https://www.refactoringui.com/ ; https://m3.material.io/styles/elevation/overview
- Semantic HTML headings define hierarchy for assistive tech; style is separate from level. — https://www.w3.org/WAI/tutorials/page-structure/headings/

## Reference

### Contrast check (tested)
```python
def L(h):
    c=[int(h[i:i+2],16)/255 for i in (1,3,5)]
    c=[x/12.92 if x<=0.04045 else ((x+0.055)/1.055)**2.4 for x in c]
    return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]
def cr(a,b):
    x,y=sorted([L(a),L(b)],reverse=True); return round((x+0.05)/(y+0.05),2)
```
`tested` 2026-11-08: black/white 21.0; Tailwind gray-500 `#6b7280` on white 4.83 (passes body); gray-400 `#9ca3af` 2.54 (fails — use only for disabled/decorative). Formula: https://www.w3.org/TR/WCAG22/#dfn-relative-luminance

### Bad → good
- Bad: `Name: Jane` / `Email: j@x.com` bold labels. Good: name large dark, email small grey, no labels.
- Bad: three equal blue buttons. Good: one solid, one outline, one text link.
- Bad: `#999` caption on `#3b82f6` card. Good: `#dbeafe` (blue-100) on blue-600.
- Bad: 1px borders around every card + section. Good: white cards on `gray-50` page with a soft shadow.

### Reference galleries (real shipped UI)
- Mobbin — mobile/web screens by flow: https://mobbin.com
- Refero — web app screens, searchable by component: https://refero.design
- Godly — curated landing pages: https://godly.website
- Land-book: https://land-book.com
- Dribbble is concept-heavy, not shipped — use for mood only: https://dribbble.com

### Component libraries / systems
- shadcn/ui (copy-in, Radix + Tailwind): https://ui.shadcn.com
- Radix Primitives / Themes (accessible unstyled): https://www.radix-ui.com
- Tailwind UI / Catalyst (paid, by Refactoring UI authors): https://tailwindcss.com/plus
- Headless UI: https://headlessui.com
- Material 3 (spec + tokens): https://m3.material.io
- Apple HIG: https://developer.apple.com/design/human-interface-guidelines
- GOV.UK Design System (best-tested forms): https://design-system.service.gov.uk

### Font tools
- Google Fonts (licences OFL): https://fonts.google.com
- Fontsource (self-host npm packages): https://fontsource.org
- Inter (UI workhorse, by Rasmus Andersson): https://rsms.me/inter/
- Typescale calculator: https://typescale.com
- Butterick's font recommendations: https://practicaltypography.com/font-recommendations.html

### Colour tools
- Tailwind palette (ready 50–950 shades): https://tailwindcss.com/docs/colors
- Radix Colors (12-step scales with defined use per step, light/dark): https://www.radix-ui.com/colors
- OKLCH picker: https://oklch.com
- Huetone (perceptual palette builder, contrast-aware): https://huetone.ardov.me
- WebAIM contrast checker: https://webaim.org/resources/contrastchecker/
- APCA (WCAG 3 draft contrast, informative only): https://git.apcacontrast.com/

## Checklist (before delivering a page)
- [ ] Every margin/padding/gap is on the spacing scale. (refactoringui.com)
- [ ] Group gaps > in-group gaps; nothing touches the viewport edge. (refactoringui.com)
- [ ] Every font size is on the type scale; ≤2 families, ≤3 weights. (refactoringui.com)
- [ ] Body ≥16px, line length ≤ ~75ch, body line-height ~1.5. (practicaltypography.com/line-length.html)
- [ ] All text ≥4.5:1, large text/UI borders ≥3:1 (run `cr()`). (w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
- [ ] No grey text on coloured backgrounds. (refactoringui.com)
- [ ] Exactly one primary button per view. (refactoringui.com)
- [ ] Squint test: the 1–2 most important things still stand out. (refactoringui.com)
- [ ] Anti-generic: brand colour is not default `#3b82f6`/`#007bff` unchanged; greys are tinted; at least one deliberate choice (display font, accent shape, illustration, or bold colour block) beyond defaults. (refactoringui.com)
- [ ] Anti-generic: not every section is a centred heading + 3 equal cards; vary layout and alignment. (refactoringui.com)
- [ ] Empty states, hover/focus/disabled states designed; visible focus ring. (w3.org/WAI/WCAG22/Understanding/focus-visible.html)
- [ ] Targets ≥24×24 CSS px (44 pt on touch). (w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- [ ] State never shown by colour alone. (w3.org/WAI/WCAG22/Understanding/use-of-color.html)

## Disagreements and unknowns
- Modular ratio scales (typescale.com, Material) vs hand-picked (Refactoring UI): trust hand-picked for product UI, ratios fine for editorial.
- WCAG 2 contrast vs APCA: APCA is better perceptually but not normative; ship to WCAG 2.2.
- Most Refactoring UI rules come from the paid book; the free subset is in its Medium posts (https://medium.com/refactoring-ui/7-practical-tips-for-cheating-at-design-40c736799886). Book page URLs not individually linkable.
- Gallery/library URLs and pricing change; accessed 2026-11-08, not fetched live (untested).

## Assumptions
- Target is web/product UI built with HTML/CSS (Tailwind likely), not print or native-only.
- Refactoring UI site + Medium post counted as primary (authors' own publication).
