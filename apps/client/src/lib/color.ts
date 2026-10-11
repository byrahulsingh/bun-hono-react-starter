/**
 * The little colour maths branding needs: which text colour reads on a given
 * accent, and whether a pair has enough contrast (WCAG 2 ratios).
 */

/** Relative luminance of `#rrggbb`, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}

/** 1 (none) to 21 (black on white). Text needs 4.5; outlines and large text 3. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Black or white, whichever reads better on `hex`. Same rule the API uses in emails. */
export function textOn(hex: string): '#000000' | '#ffffff' {
  return contrast(hex, '#ffffff') >= contrast(hex, '#000000')
    ? '#ffffff'
    : '#000000'
}

export const isHexColor = (value: string) => /^#[0-9a-f]{6}$/i.test(value)
