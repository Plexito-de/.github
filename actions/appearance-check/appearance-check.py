#!/usr/bin/env python3
"""appearance-check: how a public page looks in Google results and in share cards.

Usage: appearance-check.py https://example.com/   (exit 1 on any FAIL, 2 on no fetch)
Stdlib only. Reads the live site, never the repo, because the defects it finds
(globe favicon, www duplicate, soft 404, blocked icon) exist only in what is served.
"""
import re, struct, sys, uuid
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen, HTTPRedirectHandler, build_opener
from urllib.error import HTTPError, URLError

UA = {"User-Agent": "appearance-check/1"}
fails = 0


def say(kind, msg):
    global fails
    fails += kind == "FAIL"
    print(f"{kind:5} {msg}")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def get(url, follow=True, limit=2_000_000):
    op = build_opener() if follow else build_opener(NoRedirect)
    try:
        r = op.open(Request(url, headers=UA), timeout=15)
    except HTTPError as e:
        r = e
    except URLError:
        return None, b"", {}, url
    return r.status if hasattr(r, "status") else r.code, r.read(limit), r.headers, getattr(r, "url", url)


class Head(HTMLParser):
    def __init__(self):
        super().__init__()
        self.meta, self.links, self.title, self._t, self.lang, self.ld = {}, [], "", False, "", 0

    def handle_starttag(self, tag, a):
        a = dict(a)
        if tag == "html":
            self.lang = a.get("lang", "")
        elif tag == "title":
            self._t = True
        elif tag == "meta":
            self.meta[(a.get("name") or a.get("property") or "").lower()] = a.get("content", "")
        elif tag == "link":
            self.links.append(a)
        elif tag == "script" and a.get("type") == "application/ld+json":
            self.ld += 1

    def handle_endtag(self, tag):
        self._t = self._t and tag != "title"

    def handle_data(self, d):
        if self._t:
            self.title += d


def dims(body, ctype):
    if body[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", body[16:24])
    if body[:4] == b"\x00\x00\x01\x00":  # ICO: report the largest entry
        n = struct.unpack("<H", body[4:6])[0]
        return max(((body[6 + 16 * i] or 256), (body[7 + 16 * i] or 256)) for i in range(n))
    return None


def main(url):
    code, body, hdr, final = get(url)
    if code is None:
        print("cannot fetch", url); return 2
    u = urlparse(final)
    origin = f"{u.scheme}://{u.netloc}"
    say("PASS" if code == 200 else "FAIL", f"home {code} at {final}")
    asked = urlparse(url).netloc.removeprefix("www.")
    if u.netloc.removeprefix("www.") != asked:
        print(f"INFO  {asked} redirects off-site to {u.netloc}; nothing of this host to check")
        return 0
    p = Head(); p.feed(body.decode("utf-8", "replace"))
    t, d = p.title.strip(), p.meta.get("description", "")
    say("PASS" if 10 <= len(t) <= 60 else "FAIL", f"title {len(t)} chars (10-60): {t[:60]!r}")
    say("PASS" if 70 <= len(d) <= 160 else "FAIL", f"meta description {len(d)} chars (70-160)")
    say("PASS" if p.lang else "FAIL", f"html lang={p.lang!r}")
    say("PASS" if "viewport" in p.meta else "FAIL", "meta viewport")
    can = next((l.get("href") for l in p.links if l.get("rel") == "canonical"), "")
    say("PASS" if can.startswith("http") and urlparse(can).netloc == u.netloc else "FAIL", f"canonical {can!r} absolute and same host")
    rob = p.meta.get("robots", "") + hdr.get("X-Robots-Tag", "")
    say("FAIL" if "noindex" in rob.lower() else "PASS", f"indexable (robots meta/header: {rob!r})")

    # favicon: Google wants a raster at a multiple of 48 px, reachable, not blocked
    icons = [urljoin(final, l["href"]) for l in p.links if "icon" in l.get("rel", "") and "apple" not in l.get("rel", "")]
    icons.append(origin + "/favicon.ico")
    best = 0
    for i in dict.fromkeys(icons):
        c, b, h, _ = get(i)
        dm = dims(b, h.get("Content-Type", "")) if c == 200 else None
        if dm and dm[0] == dm[1] and dm[0] % 48 == 0:
            best = max(best, dm[0])
        say("INFO", f"icon {c} {dm or h.get('Content-Type', '?')} {i[:90]}")
    say("PASS" if best else "FAIL", f"favicon: square raster at a multiple of 48 px reachable (best {best})")
    ap = next((urljoin(final, l["href"]) for l in p.links if "apple-touch-icon" in l.get("rel", "")), "")
    say("PASS" if ap and get(ap)[0] == 200 else "FAIL", "apple-touch-icon reachable")

    # share card
    for k in ("og:title", "og:description", "og:image", "twitter:card"):
        say("PASS" if p.meta.get(k) else "FAIL", f"{k} present")
    oi = p.meta.get("og:image", "")
    if oi:
        c, b, h, _ = get(urljoin(final, oi), limit=10_000_000)
        ct = h.get("Content-Type", "")
        ok = c == 200 and ct.startswith("image/") and oi.startswith("http")
        say("PASS" if ok else "FAIL", f"og:image absolute, 200, an image ({c}, {ct or 'no type'}, {len(b)//1024} KB)")
        say("PASS" if len(b) < 8_000_000 else "FAIL", "og:image under 8 MB")

    # crawl surface
    c, b, _, _ = get(origin + "/robots.txt")
    rtxt = b.decode("utf-8", "replace") if c == 200 else ""
    blocked = re.search(r"(?im)^user-agent:\s*\*\s*(?:\n(?!user-agent).*)*?^disallow:\s*/\s*$", rtxt)
    say("FAIL" if blocked else "PASS", f"robots.txt {c}, site not fully disallowed")
    sm = re.search(r"(?im)^sitemap:\s*(\S+)", rtxt)
    say("PASS" if sm and get(sm.group(1))[0] == 200 else "FAIL", "sitemap declared in robots.txt and 200")
    say("INFO", f"JSON-LD blocks: {p.ld}")

    # the other host must redirect to this one, or Google indexes two sites (and two favicons)
    host = u.netloc
    other = host[4:] if host.startswith("www.") else "www." + host
    c, _, h, _ = get(f"{u.scheme}://{other}/", follow=False)
    loc = h.get("Location", "")
    why = "" if c in (301, 308) else " (307/302 is temporary: use 301 or 308)" if c in (302, 307) else ""
    say("PASS" if c in (301, 308) and urlparse(loc).netloc == host else "FAIL", f"{other} -> {c} {loc or '(no redirect)'}{why}")
    c, _, _, _ = get(f"{origin}/{uuid.uuid4().hex}")
    say("PASS" if c == 404 else "FAIL", f"unknown path returns {c} (404 expected, not a soft 404)")
    print(f"{'FAILED' if fails else 'OK'}: {fails} fail(s). Google refreshes favicons and snippets in days to weeks.")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]) if len(sys.argv) == 2 else print(__doc__) or 2)
