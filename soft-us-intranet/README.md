# Soft US Intranet

An exploration of using Pi-hole (plus custom DNS software) to filter traffic on a home
network by the nationality of the destination — a "soft intranet" where the network
prefers US-hosted destinations and softly blocks or flags everything else.

"Soft" is the operative word: the goal is not an airtight national firewall (which DNS
alone cannot deliver), but a policy layer that is observable, tunable, and easy to
override — log first, block second, always with an allowlist escape hatch.

## Why DNS?

Pi-hole sits in the resolution path for every device on the LAN that uses it as its DNS
server. If a domain never resolves, most traffic to it never starts. That makes DNS a
cheap, central choke point — no per-device agents, no inline proxy. The tradeoff is that
DNS only sees *names*, not packets, so anything that bypasses DNS (hardcoded IPs, DoH)
needs a firewall backstop.

## Candidate approaches

### 1. ccTLD regex blocking (pure Pi-hole, no custom code)

Pi-hole supports regex blocklists natively. Blocking country-code TLDs is a one-liner
per country:

```
(\.|^)example-pattern\.(ru|cn|ir|kp)$
```

- **Pros:** zero new software; works today in stock Pi-hole.
- **Cons:** very coarse. ccTLD says nothing about where a service is hosted (`.io`,
  `.tv`, `.ai` are ccTLDs used globally; plenty of non-US services live on `.com`).
  Useful as a first filter, not as the mechanism.

### 2. Geo-aware upstream DNS proxy (the custom-software core)

Insert a small custom DNS forwarder between Pi-hole and its upstream resolver:

```
LAN clients → Pi-hole (ads/blocklists, logging, UI)
                 → geo-dns-proxy (custom: resolve, geolocate answer IPs)
                     → upstream resolver (Unbound / 1.1.1.1 / etc.)
```

The proxy resolves each query upstream, looks up every A/AAAA answer in an IP-to-country
database (MaxMind GeoLite2 or IP2Location LITE, both free tiers), and applies policy:

- **observe mode:** pass everything, log `domain → IPs → country` to a database.
- **soft mode:** answers that geolocate outside the allowed set (e.g. `US`) get NXDOMAIN
  or `0.0.0.0`, unless the domain is on the allowlist.
- Per-country and per-domain allow/deny lists, hot-reloadable.

- **Pros:** real geolocation of actual answers; Pi-hole stays stock (its UI, stats, and
  ad-blocking keep working); the custom piece is a small standalone daemon (Go or Python
  with `dnslib`/`miekg/dns`), easy to test in isolation.
- **Cons:** adds a hop; must handle TTLs, CNAME chains, and caching correctly; geo
  databases are approximate.

This is the most promising direction for the "custom software" part of the project.

### 3. dnsmasq ipset/nftset handoff + firewall enforcement

Pi-hole's engine (pihole-FTL, a dnsmasq fork) supports `ipset=`/`nftset=` directives:
resolved IPs for matching domains are inserted into kernel sets, and nftables/iptables
rules decide what to do with packets to those IPs. Combined with a GeoIP-populated set
(e.g. nftables sets built from country CIDR lists), the *firewall* blocks by country
while DNS stays honest.

- **Pros:** blocks actual traffic, including hardcoded-IP and DoH-bypass flows; "soft"
  is expressible as firewall logging vs. dropping.
- **Cons:** needs the router/gateway under our control; country CIDR lists are large and
  churn; this is firewall engineering more than Pi-hole engineering.

Best treated as the eventual backstop layer, not the starting point.

### 4. Post-hoc geo analytics on the Pi-hole query log

Before blocking anything, geolocate what the network already talks to. Pi-hole keeps a
long-term query database (`/etc/pihole/pihole-FTL.db`). A small batch job can resolve or
join the answered domains against GeoLite2 and produce a "where does our traffic go"
dashboard by country, client, and domain.

- **Pros:** zero risk; produces the data needed to size allowlists before any blocking
  is turned on; great first milestone.
- **Cons:** observational only.

## Proposed roadmap

1. **M1 — Observe:** geo analytics over the Pi-hole FTL database (approach 4). Deliver a
   report/dashboard of destination countries per client.
2. **M2 — Proxy in observe mode:** build the geo-dns-proxy (approach 2), run it between
   Pi-hole and upstream, logging only. Validate correctness against M1's data.
3. **M3 — Soft blocking:** enable NXDOMAIN policy for non-US answers with allowlist,
   per-client opt-in (Pi-hole groups), and an easy kill switch.
4. **M4 — Firewall backstop (stretch):** nftables GeoIP sets for DoH/hardcoded-IP
   leakage (approach 3).

## Known limitations (worth writing down early)

- **CDNs blur nationality.** A foreign service on Cloudflare/Akamai will often resolve
  to a US POP, and a US service can resolve to a nearby foreign POP. Answer-IP
  geolocation measures *where the traffic lands*, not who operates the service.
- **DNS bypass.** Devices using DoH/DoT or hardcoded resolvers skip Pi-hole entirely;
  only the firewall layer (M4) catches those.
- **Geo databases are approximate,** especially for anycast ranges; expect false
  positives and keep the allowlist workflow cheap.
- **Dual-stack:** policy must cover AAAA answers too, or IPv6 becomes the bypass.

## Layout (planned)

```
soft-us-intranet/
  README.md            ← this document
  geo-analytics/       ← M1: FTL database → country report
  geo-dns-proxy/       ← M2/M3: custom DNS forwarder with geo policy
  firewall/            ← M4: nftables GeoIP backstop notes/scripts
```
