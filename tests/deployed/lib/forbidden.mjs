const evidenceLinkPattern = /evidence link/iu;
const FORBIDDEN = [
  /cht_[^…]/iu,
  /cvs_[^…]/iu,
  /rit_[^…]/iu,
  /sni_/iu,
  /snk_/iu,
  /ev1\./iu,
  /trycloudflare/iu,
  /operator/iu,
  /invite code/iu,
  /request access/iu,
  evidenceLinkPattern,
  /Chorus creates/iu,
];

export function forbiddenMatches(content) {
  return FORBIDDEN.filter((pattern) => {
    const scanned =
      pattern === evidenceLinkPattern ? content.replace(/Not yet available:[^\n]*/gu, '') : content;
    return pattern.test(scanned);
  });
}
