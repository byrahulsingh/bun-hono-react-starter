/**
 * What an email says, and how it looks.
 *
 * Feature code writes only the words (EmailContent). The branded layout —
 * logo, product name, accent colour, sender name — is applied when the email
 * is sent, so a branding change reaches emails still waiting in the outbox,
 * and no feature module needs to know about branding.
 */

import type { Branding } from '#/modules/branding';
import { assetUrl } from '#/modules/branding';
import type { EmailMessage } from '#/modules/providers/email';

export interface EmailContent {
  to: string;
  subject: string;
  /** Plain text, in order. The layout escapes them. */
  paragraphs: string[];
  /** The one thing to click: a button in HTML, `label: url` in plain text. */
  action?: { label: string; url: string };
  /** Small print under the action. */
  note?: string;
}

/** Neutral dark grey, like the app's own default buttons. */
const DEFAULT_ACCENT = '#171717';

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Black or white text, whichever reads better on `hex` (WCAG relative luminance). */
export function textOn(hex: string): '#000000' | '#ffffff' {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  // Contrast with white is 1.05/(l+0.05), with black (l+0.05)/0.05: pick the larger.
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? '#ffffff' : '#000000';
}

export function renderText(content: EmailContent, brand: Branding): string {
  const parts = [...content.paragraphs];
  if (content.action) parts.push(`${content.action.label}: ${content.action.url}`);
  if (content.note) parts.push(content.note);
  parts.push(`— ${brand.product_name}`);
  return parts.join('\n\n');
}

/**
 * Table layout with inline styles: what every mail client, Outlook included,
 * renders the same. Only PNG and JPEG logos are shown; many clients drop SVG
 * and WebP, so with those the product name stands in.
 */
export function renderHtml(content: EmailContent, brand: Branding): string {
  const accent = brand.accent_color ?? DEFAULT_ACCENT;
  const name = escape(brand.product_name);
  const logo = brand.logo && ['image/png', 'image/jpeg'].includes(brand.logo.content_type) ? brand.logo : null;

  const header = logo
    ? `<img src="${escape(assetUrl(logo))}" alt="${name}" height="32" style="display:block;height:32px;max-width:200px;border:0">`
    : `<span style="font-size:18px;font-weight:600;color:#171717">${name}</span>`;

  const paragraphs = content.paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#262626">${escape(p)}</p>`)
    .join('');

  const action = content.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="border-radius:8px;background:${accent}">` +
      `<a href="${escape(content.action.url)}" style="display:inline-block;padding:12px 20px;font-size:15px;font-weight:600;color:${textOn(accent)};text-decoration:none;border-radius:8px">${escape(content.action.label)}</a>` +
      `</td></tr></table>` +
      `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#737373">Or paste this link into your browser:<br><a href="${escape(content.action.url)}" style="color:#525252;word-break:break-all">${escape(content.action.url)}</a></p>`
    : '';

  const note = content.note ? `<p style="margin:0;font-size:13px;line-height:1.5;color:#737373">${escape(content.note)}</p>` : '';

  return [
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escape(content.subject)}</title></head>`,
    '<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5"><tr><td align="center" style="padding:32px 16px">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">',
    `<tr><td style="padding:0 4px 16px">${header}</td></tr>`,
    `<tr><td style="background:#ffffff;border-radius:12px;border-top:4px solid ${accent};padding:32px">${paragraphs}${action}${note}</td></tr>`,
    `<tr><td style="padding:16px 4px;font-size:12px;color:#a3a3a3">Sent by ${name}</td></tr>`,
    '</table></td></tr></table></body></html>',
  ].join('');
}

export function renderEmail(content: EmailContent, brand: Branding): EmailMessage {
  return {
    to: content.to,
    subject: content.subject,
    text: renderText(content, brand),
    html: renderHtml(content, brand),
    fromName: brand.product_name,
  };
}
