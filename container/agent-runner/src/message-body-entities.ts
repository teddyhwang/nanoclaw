/**
 * Decode XML character escapes the model applied to a `<message>` body.
 *
 * Agents answer inside `<message to="name">…</message>` and read their context
 * as XML (`formatter.ts` escapes `&`, `<`, `>` and `"` there), so a model
 * sometimes XML-escapes the body it writes: the calendar title "Wings, VR &
 * Drinks" came back as "Wings, VR &amp; Drinks" and was posted and stored that
 * way (Tico Telegram week-ahead digest, Nov 15 2026, message -5588587578:2961).
 * The tag is our wrapper, so its body is decoded once, like an XML parser would.
 *
 * Guarded so literal text survives:
 * - Only when every `&` in the prose starts a known XML escape (`&amp;`,
 *   `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&#NN;`, `&#xHH;`). A bare `&` or an
 *   HTML-only name such as `&nbsp;` means the author wrote raw text: unchanged.
 * - Code spans and fenced blocks are never decoded: entity text there is
 *   deliberate (an HTML example) and must reach the user byte-identical.
 * - One pass: `&amp;lt;` becomes `&lt;`, never `<`.
 */

const ENTITY = /&(?:amp|lt|gt|quot|apos|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});/g;
const ANY_AMPERSAND = /&/g;
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]+`/g;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntity(entity: string): string {
  const name = entity.slice(1, -1);
  if (name in NAMED) return NAMED[name];
  const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  // Invalid or control code points stay literal rather than inject odd bytes.
  if (
    !Number.isFinite(code) ||
    code > 0x10ffff ||
    (code >= 0xd800 && code <= 0xdfff) ||
    (code < 0x20 && code !== 9 && code !== 10 && code !== 13)
  ) {
    return entity;
  }
  return String.fromCodePoint(code);
}

export function decodeXmlEscapedMessageBody(body: string): string {
  if (!body.includes('&')) return body;
  const prose: string[] = [];
  const code: string[] = [];
  let last = 0;
  for (const match of body.matchAll(CODE)) {
    prose.push(body.slice(last, match.index));
    code.push(match[0]);
    last = match.index + match[0].length;
  }
  prose.push(body.slice(last));

  let ampersands = 0;
  let entities = 0;
  for (const part of prose) {
    ampersands += (part.match(ANY_AMPERSAND) ?? []).length;
    entities += (part.match(ENTITY) ?? []).length;
  }
  if (entities === 0 || entities !== ampersands) return body;

  let out = '';
  prose.forEach((part, i) => {
    out += part.replace(ENTITY, decodeEntity);
    if (i < code.length) out += code[i];
  });
  return out;
}
