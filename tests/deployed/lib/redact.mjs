const SECRET = /(?:sni_|cht_|cvs_|rit_)[^\s"'<>),;]*/gu;
const AUTHORIZATION = /authorization\s*:\s*[^\r\n,]+/giu;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /^(authorization|content)$/iu.test(key) ? '<redacted>' : redact(entry),
      ]),
    );
  }
  if (typeof value !== 'string') return value;
  return value.replace(AUTHORIZATION, 'Authorization: <redacted>').replace(SECRET, '<redacted>');
}
