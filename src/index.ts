type DnsAnswer = {
  name: string;
  type: number;
  TTL: number;
  data: string;
};

type DnsJsonResponse = {
  Status?: number;
  TC?: boolean;
  RD?: boolean;
  RA?: boolean;
  AD?: boolean;
  CD?: boolean;
  Question?: Array<{ name: string; type: number }>;
  Answer?: DnsAnswer[];
  Authority?: DnsAnswer[];
  Comment?: string;
};

type ResolverId = "cloudflare" | "google";

type Resolver = {
  id: ResolverId;
  label: string;
  display: string;
  endpoint: string;
};

type ResolverResult = {
  resolver: ResolverId;
  label: string;
  display: string;
  httpStatus: number | null;
  ok: boolean;
  latencyMs: number;
  rcode: number | null;
  rcodeText: string;
  ad: boolean | null;
  cd: boolean | null;
  answers: DnsAnswer[];
  authority: DnsAnswer[];
  normalizedAnswers: string[];
  error?: string;
};

const RESOLVERS: Resolver[] = [
  {
    id: "cloudflare",
    label: "Cloudflare DNS",
    display: "1.1.1.1",
    endpoint: "https://cloudflare-dns.com/dns-query",
  },
  {
    id: "google",
    label: "Google Public DNS",
    display: "8.8.8.8",
    endpoint: "https://dns.google/resolve",
  },
];

const ALLOWED_TYPES = new Set(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA"]);

const RCODE: Record<number, string> = {
  0: "NOERROR",
  1: "FORMERR",
  2: "SERVFAIL",
  3: "NXDOMAIN",
  4: "NOTIMP",
  5: "REFUSED",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function normalizeDomain(input: string): string {
  return input.trim().replace(/\.$/, "").toLowerCase();
}

function isValidDomain(input: string): boolean {
  const domain = normalizeDomain(input);

  if (domain.length < 1 || domain.length > 253) return false;
  if (domain.includes("..")) return false;

  const labels = domain.split(".");
  return labels.every((label) => {
    if (label.length < 1 || label.length > 63) return false;
    return /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label);
  });
}

function buildDoHUrl(resolver: Resolver, domain: string, type: string): string {
  const url = new URL(resolver.endpoint);

  if (resolver.id === "cloudflare") {
    url.searchParams.set("name", domain);
    url.searchParams.set("type", type);
    return url.toString();
  }

  url.searchParams.set("name", domain);
  url.searchParams.set("type", type);
  url.searchParams.set("edns_client_subnet", "0.0.0.0/0");
  return url.toString();
}

function statusLabel(status: number | undefined): string {
  if (typeof status !== "number") return "UNKNOWN";
  return RCODE[status] ?? `RCODE_${status}`;
}

function normalizeAnswerData(answer: DnsAnswer): string {
  return answer.data.trim().replace(/\.$/, "").toLowerCase();
}

function normalizeAnswers(answers: DnsAnswer[] | undefined): string[] {
  return (answers ?? [])
    .map((answer) => `${answer.type}:${normalizeAnswerData(answer)}`)
    .sort();
}

async function fetchDns(resolver: Resolver, domain: string, type: string): Promise<ResolverResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), 3000);

  try {
    const response = await fetch(buildDoHUrl(resolver, domain, type), {
      headers: {
        accept: "application/dns-json",
      },
      signal: controller.signal,
    });

    const latencyMs = Date.now() - started;
    const body = (await response.json()) as DnsJsonResponse;
    const answers = body.Answer ?? [];

    return {
      resolver: resolver.id,
      label: resolver.label,
      display: resolver.display,
      httpStatus: response.status,
      ok: response.ok,
      latencyMs,
      rcode: body.Status ?? null,
      rcodeText: statusLabel(body.Status),
      ad: body.AD ?? null,
      cd: body.CD ?? null,
      answers,
      authority: body.Authority ?? [],
      normalizedAnswers: normalizeAnswers(answers),
    };
  } catch (error) {
    return {
      resolver: resolver.id,
      label: resolver.label,
      display: resolver.display,
      httpStatus: null,
      ok: false,
      latencyMs: Date.now() - started,
      rcode: null,
      rcodeText: "FETCH_ERROR",
      ad: null,
      cd: null,
      answers: [],
      authority: [],
      normalizedAnswers: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sameAnswers(left: ResolverResult, right: ResolverResult): boolean {
  return JSON.stringify(left.normalizedAnswers) === JSON.stringify(right.normalizedAnswers);
}

function judge(cloudflare: ResolverResult, google: ResolverResult): string {
  if (!cloudflare.ok || !google.ok) return "ERROR";

  const sameRcode = cloudflare.rcode === google.rcode;
  const sameAnswerSet = sameAnswers(cloudflare, google);

  if (sameRcode && sameAnswerSet) return "MATCH";

  const cloudflareResolved = cloudflare.rcode === 0 && cloudflare.answers.length > 0;
  const googleResolved = google.rcode === 0 && google.answers.length > 0;

  if (cloudflareResolved && !googleResolved) return "ONLY_CLOUDFLARE_OK";
  if (!cloudflareResolved && googleResolved) return "ONLY_GOOGLE_OK";
  if (!cloudflareResolved && !googleResolved) return "BOTH_FAIL_DIFFERENT_RCODE";

  return "MISMATCH";
}

async function handleResolve(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const domainInput = url.searchParams.get("domain") ?? "";
  const type = (url.searchParams.get("type") ?? "A").toUpperCase();

  if (!isValidDomain(domainInput)) {
    return json({ error: "invalid domain" }, 400);
  }

  if (!ALLOWED_TYPES.has(type)) {
    return json({ error: "invalid record type" }, 400);
  }

  const domain = normalizeDomain(domainInput);
  const [cloudflare, google] = await Promise.all(
    RESOLVERS.map((resolver) => fetchDns(resolver, domain, type)),
  );

  return json({
    domain,
    type,
    checkedAt: new Date().toISOString(),
    verdict: judge(cloudflare, google),
    resolvers: [cloudflare, google],
  });
}

function renderApp(): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>isvisible</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f7fb;
      color: #172033;
    }
    body {
      margin: 0;
      padding: 32px;
    }
    main {
      max-width: 980px;
      margin: 0 auto;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 32px;
      letter-spacing: -0.04em;
    }
    p {
      color: #596579;
      line-height: 1.7;
    }
    form {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 150px 120px;
      gap: 12px;
      margin: 24px 0;
    }
    input, select, button {
      box-sizing: border-box;
      width: 100%;
      font: inherit;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid #cfd6e4;
      background: #ffffff;
      color: #172033;
    }
    button {
      cursor: pointer;
      border-color: #2563eb;
      background: #2563eb;
      color: #ffffff;
      font-weight: 700;
    }
    .verdict {
      display: inline-block;
      margin: 8px 0 18px;
      padding: 8px 12px;
      border-radius: 999px;
      font-weight: 800;
      font-size: 14px;
    }
    .MATCH { background: #dcfce7; color: #166534; }
    .MISMATCH { background: #fef9c3; color: #854d0e; }
    .ONLY_CLOUDFLARE_OK, .ONLY_GOOGLE_OK, .BOTH_FAIL_DIFFERENT_RCODE { background: #fee2e2; color: #991b1b; }
    .ERROR { background: #111827; color: #ffffff; }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: #ffffff;
      border: 1px solid #d8dee8;
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
    }
    .card h2 {
      margin: 0 0 4px;
      font-size: 20px;
    }
    .meta {
      color: #64748b;
      font-size: 14px;
      margin-bottom: 12px;
    }
    .rcode {
      font-size: 20px;
      font-weight: 900;
      margin: 12px 0;
    }
    .answers {
      margin: 0;
      padding-left: 20px;
    }
    .answers li {
      margin: 7px 0;
      word-break: break-all;
    }
    .empty {
      color: #64748b;
    }
    pre {
      overflow: auto;
      background: #0f172a;
      color: #e2e8f0;
      padding: 16px;
      border-radius: 16px;
      font-size: 12px;
      line-height: 1.5;
    }
    @media (prefers-color-scheme: dark) {
      :root { background: #0b1020; color: #e5e7eb; }
      p, .meta, .empty { color: #94a3b8; }
      input, select { background: #111827; color: #e5e7eb; border-color: #334155; }
      .card { background: #111827; border-color: #334155; }
    }
    @media (max-width: 720px) {
      body { padding: 18px; }
      form { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <h1>isvisible</h1>
    <p>入力したドメインを Cloudflare DNS 1.1.1.1 相当と Google Public DNS 8.8.8.8 相当で比較します。</p>

    <form id="form">
      <input id="domain" name="domain" placeholder="example.com" autocomplete="off" required />
      <select id="type" name="type">
        <option>A</option>
        <option>AAAA</option>
        <option>CNAME</option>
        <option>MX</option>
        <option>TXT</option>
        <option>NS</option>
        <option>SOA</option>
      </select>
      <button type="submit">確認</button>
    </form>

    <section id="result"></section>
  </main>

  <script>
    const form = document.getElementById("form");
    const result = document.getElementById("result");

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function renderAnswers(answers) {
      if (!answers || answers.length === 0) {
        return "<p class=\"empty\">Answerなし</p>";
      }

      return "<ul class=\"answers\">" + answers.map(function(answer) {
        return "<li><strong>TTL " + escapeHtml(answer.TTL) + "</strong> " + escapeHtml(answer.data) + "</li>";
      }).join("") + "</ul>";
    }

    function renderResolver(resolver) {
      const error = resolver.error ? "<pre>" + escapeHtml(resolver.error) + "</pre>" : "";

      return "<article class=\"card\">" +
        "<h2>" + escapeHtml(resolver.label) + "</h2>" +
        "<div class=\"meta\">" + escapeHtml(resolver.display) + " / latency: " + escapeHtml(resolver.latencyMs) + "ms</div>" +
        "<div class=\"rcode\">" + escapeHtml(resolver.rcodeText) + "</div>" +
        "<div class=\"meta\">AD: " + escapeHtml(resolver.ad) + " / CD: " + escapeHtml(resolver.cd) + " / HTTP: " + escapeHtml(resolver.httpStatus) + "</div>" +
        renderAnswers(resolver.answers) +
        error +
        "</article>";
    }

    form.addEventListener("submit", async function(event) {
      event.preventDefault();

      const domain = document.getElementById("domain").value;
      const type = document.getElementById("type").value;

      result.innerHTML = "<p>確認中...</p>";

      try {
        const response = await fetch("/api/resolve?domain=" + encodeURIComponent(domain) + "&type=" + encodeURIComponent(type));
        const data = await response.json();

        if (!response.ok) {
          result.innerHTML = "<pre>" + escapeHtml(JSON.stringify(data, null, 2)) + "</pre>";
          return;
        }

        result.innerHTML =
          "<div class=\"verdict " + escapeHtml(data.verdict) + "\">" + escapeHtml(data.verdict) + "</div>" +
          "<div class=\"grid\">" + data.resolvers.map(renderResolver).join("") + "</div>" +
          "<h2>Raw JSON</h2>" +
          "<pre>" + escapeHtml(JSON.stringify(data, null, 2)) + "</pre>";
      } catch (error) {
        result.innerHTML = "<pre>" + escapeHtml(error && error.message ? error.message : String(error)) + "</pre>";
      }
    });
  </script>
</body>
</html>`;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/resolve") {
      return handleResolve(request);
    }

    return html(renderApp());
  },
};
