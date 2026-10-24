/**
 * PCRE-shaped patterns in JavaScript.
 *
 * Bank profiles are written with PCRE's leading inline flag group, `(?i)` or
 * `(?im)`. JavaScript has no equivalent form, so lift it into RegExp flags and
 * compile the rest unchanged.
 *
 * Validated before the port: all 148 distinct profile patterns run against all
 * 64 fixture texts in both PCRE and JavaScript, compared on match and on every
 * named capture -- 9,472 of 9,472 identical. Do not "modernise" profile
 * patterns into JS-native form; that check is what makes them portable.
 */
const cache = new Map<string, RegExp | null>();

export function compile(pattern: string | null | undefined): RegExp | null {
  // A template may simply not declare a field; that is not an error.
  if (!pattern) return null;
  const hit = cache.get(pattern);
  if (hit !== undefined) return hit;

  let body = pattern;
  let flags = 'u';
  const m = body.match(/^\(\?([a-zA-Z]+)\)/);
  if (m) {
    body = body.slice(m[0].length);
    for (const f of m[1]) if ('ims'.includes(f)) flags += f;
  }

  let re: RegExp | null = null;
  try {
    re = new RegExp(body, flags);
  } catch {
    // A broken pattern is a profile bug, not a client error: it must not take
    // the request down, so it simply never matches.
    console.error('spendie: invalid parser pattern:', pattern);
  }
  cache.set(pattern, re);
  return re;
}

/** Does the pattern match? A broken pattern never matches. */
export function test(pattern: string | null | undefined, text: string): boolean {
  return compile(pattern)?.test(text) ?? false;
}

/** The named group, or the first capture, or null. */
export function capture(pattern: string | null | undefined, text: string, group: string): string | null {
  const re = compile(pattern);
  if (!re) return null;
  const m = text.match(re);
  if (!m) return null;
  const v = m.groups?.[group] ?? m[1] ?? null;
  return v === undefined || v === '' ? null : v;
}
