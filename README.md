# isvisible

`isvisible` is a small Cloudflare Worker for checking whether a DNS name is visible through multiple public resolvers.

The initial implementation compares:

- Cloudflare DNS, shown as `1.1.1.1`
- Google Public DNS, shown as `8.8.8.8`

It uses DNS over HTTPS from the Worker runtime.

## What it does

- Accepts a user-entered domain name
- Supports `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`, and `SOA`
- Queries Cloudflare DNS and Google Public DNS in parallel
- Displays resolver status, RCODE, answers, TTL, latency, AD/CD flags, and raw JSON
- Highlights resolver differences such as `MATCH`, `MISMATCH`, `ONLY_CLOUDFLARE_OK`, and `ONLY_GOOGLE_OK`

## Important limitation

This checks DNS visibility **from the Cloudflare Workers runtime**, not from the user's local network.

It is useful for comparing public resolver behavior, such as:

- `1.1.1.1` resolves but `8.8.8.8` does not
- one resolver returns `SERVFAIL`
- one resolver returns `NXDOMAIN`
- both resolve but return different answers

It does not detect local DNS issues inside a user's office, LAN, VPN, OS DNS cache, or split-horizon DNS environment.

## API

```text
GET /api/resolve?domain=example.com&type=A
```

Example:

```bash
curl "https://<your-worker>/api/resolve?domain=example.com&type=A"
```

Response shape:

```json
{
  "domain": "example.com",
  "type": "A",
  "checkedAt": "2026-07-04T00:00:00.000Z",
  "verdict": "MATCH",
  "resolvers": [
    {
      "resolver": "cloudflare",
      "label": "Cloudflare DNS",
      "display": "1.1.1.1",
      "rcodeText": "NOERROR",
      "answers": []
    },
    {
      "resolver": "google",
      "label": "Google Public DNS",
      "display": "8.8.8.8",
      "rcodeText": "NOERROR",
      "answers": []
    }
  ]
}
```

## Local development

```bash
npm install
npm run dev
```

## Deployment

Worker settings are intended to be managed from the Cloudflare dashboard.

This repository intentionally does not include `wrangler.toml`.

For CLI deployment, pass the entrypoint explicitly:

```bash
npx wrangler deploy src/index.ts
```
