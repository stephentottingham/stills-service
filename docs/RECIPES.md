# Recipes: the adjustment maths

Code: `packages/recipe/src`. The same code runs in the editor and on the server.

## Order

1. **Geometry**, as one inverse mapping from each output pixel back to the source: quarter-turn, then flip, then straighten, then crop. Straightening scales the frame so that it stays inside the picture (Lightroom's "constrain to image"). Crops are normalised (0..1) in the straightened frame. Sampling is bilinear, with supersampling when shrinking.
2. **White balance and exposure**, in linear light. Temperature and tint are log-ratio gains on R, G and B (`WB_ALPHA = 0.4`, `WB_GAMMA = 0.3` per full slider), normalised so brightness holds. Exposure is ×2^EV.
3. **Tone curve** on luminance (Rec. 709 weights, display-referred). Colour follows by ratio, so hues hold.
   - Shadows: `y + s·2y(0.5−y)` below middle grey.
   - Highlights: positive is `y + h·2(y−0.5)(1−y)`. Negative is a soft compression `0.5 + (y−0.5)/(1 + 1.2|h|(y−0.5))`, which also brings back values that exposure pushed past white.
   - Whites and blacks move the end points: `bp = −0.08·blacks`, `wp = 1 − 0.2·whites`.
   - Contrast: a symmetric S-curve around middle grey, power `2^(0.9c)`.
4. **Clarity**: midtone-weighted local contrast against a blur whose radius is 1.5% of the frame. **Local contrast**: CLAHE on an 8×8 tile grid (the same grid at any size), blended in.
5. **Colour**: warmth (a gentle R/B grade that keeps brightness), then saturation, then vibrance (stronger on muted colours).
6. **Black and white**: luminance.
7. **Vignette**: radial, relative to the output frame. Negative darkens, positive lightens towards white.
8. **Sharpen**: unsharp mask on luminance, 1 px radius at the output size, with a small threshold.

## Auto

`autoRecipe()` looks at a ~512 px copy:

- **White balance**: grey world in linear light, ignoring clipped and very dark pixels, softened to 70% (scenes that really are one colour stay that colour).
- **Exposure**: from the median, aiming for middle grey.
- **Highlights**: pulled back if exposure pushed the top 0.5% past white.
- **Whites and blacks**: set so the 0.5% and 99.5% points land near 2% and 97%.
- **Shadows and contrast**: from what is left (the lower quartile and the spread).
- **Local contrast**: set when the picture is flat.
- **Straighten**: from a magnitude-weighted histogram of edge angles within ±10° of level. Applied only when the peak is clear. Never overrides an angle someone has set.

## Tests

`packages/recipe/test`: normalising; geometry (turns, flips, crops); direction of each control; preview-against-full-size agreement; Auto on dark and colour-cast pictures; tilt detection.

## Phase 3

Curves and HSL by colour band slot in after step 3 and step 5. Adobe's Lightroom API (Auto Tone, presets, RAW) would run as a separate "develop" step that makes a new master. Recipes would then apply on top of it.
