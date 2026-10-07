# Showroom / live instrument

The redesign follows the user's supplied **Lamborghini.com — Style Reference**. Refero's bundled typography, motion, visual QA and anti-slop references supply craft checks. Live Refero searches were attempted but returned `NO_SUBSCRIPTION`; no live research result is claimed.

## Reference lock

- Dominant direction: automotive showroom. Carbon stage, oversized uppercase industrial type, white editorial results, zero-radius controls and hairline structure.
- One chromatic element: the active instrument, `#ffc000`. The supplied reference contradicts itself on yellow CTAs; its explicit token rule and final prompt guide reserve yellow for supporting emphasis and neutral primary actions. The implementation follows those roles: white CTA, yellow measured arc/needle.
- Secondary ingredients: Refero's motion guide contributes interruptible, purposeful state transitions and reduced motion; its typography guide contributes tabular figures and self-hosted fonts. The user's Speedtest requirement contributes a live circular gauge and an explicit run → result sequence.
- Media strategy: the working SVG instrument is the product showcase. The reference's large visual stage remains dominant; an unrelated car photograph would compete with the measurement task. Geometry is editable UI, not a simulated photograph.
- Reject: blue/red neon dashboard chrome, decorative gradients, soft shadows, floating rounded cards, invented connection metrics, fake fluctuations in real tests.

| Decision | Source / role | Reason |
| --- | --- | --- |
| `#202020` stage / `#181818` navigation / white results | Supplied showroom and editorial surface roles | Clear separation between action and evidence |
| Condensed uppercase display at weight 400 and .023em tracking | Supplied industrial typography | Strong hierarchy through scale; Roboto Condensed adds Cyrillic support under OFL |
| Zero radii and 8px spacing rhythm | Supplied shape and spacing rules | Consistent automotive precision |
| Yellow arc and radial pointer | Supplied accent role + user's live speedometer request | A single visual signal directly linked to measured speed |
| Exponential interpolation to measured targets | Refero motion feedback/continuity guidance | Smooth movement without inventing measurement samples |
| 100ms status polling and bounded real trace | User's animation request | Responsive display with predictable memory and no external frontend dependency |
| Reduced-motion path / keyboard focus / labelled demo | Refero accessibility and motion guidance | Full functionality without mandatory animation or misleading synthetic results |

## Measurement states

Ready → downloading (10 sequential requests) → completed / partial / cancelled. A disconnected local server shows an unconfirmed state and reconnect action. Demo has its own explicit label, result mode and export metadata. Starting a real run clears synthetic data.

`live_mbps` is the latest measured current-request average. UI interpolation only affects presentation. The trace stores actual measurement events; final throughput remains successful bytes divided by successful full-request time. Gauge range expands to contain measured values and stays stable during the run.

Font assets and license: [FONTS.md](FONTS.md).

## Verification

- Browser review at 1440, 768, 390 and 320 CSS pixels; the narrowest headline was resized to eliminate horizontal overflow. Pointer geometry stays outside the numeric tick labels.
- Completed a real 10-request, 50 MB run from the local dashboard. Inspected the live pointer, completed result and real trace, plus the HTTP 404 state and demo cancellation.
- Twenty Python tests cover the measurement engine, local API, real byte accounting, frozen session duration and bounded telemetry. A separate JavaScript behavior smoke check covers demo completion, adaptive scales, cancellation, late responses and reconnection.
- All web assets and fonts are served locally; the browser console showed no errors during verification.
