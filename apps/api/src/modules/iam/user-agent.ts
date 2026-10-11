/**
 * "Chrome on macOS" from a User-Agent string, for emails about a sign-in.
 * Good enough to recognise your own devices; not for anything that matters
 * (a User-Agent is whatever the browser chooses to send).
 */

const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Version\/.*Safari\//, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
];

const first = (ua: string, list: [RegExp, string][]) => list.find(([pattern]) => pattern.test(ua))?.[1];

export function describeUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = first(ua, BROWSERS);
  const system = first(ua, SYSTEMS);
  return browser && system ? `${browser} on ${system}` : (browser ?? system ?? 'Unknown device');
}
