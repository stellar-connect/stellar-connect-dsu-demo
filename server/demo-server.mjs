// STELLAR CONNECT demo server for AX Playground (or any Node host).
// - Serves the demo build (dist-demo) with single-page-app fallback.
// - POST /api/spark/briefing relays a name-free class summary to an OpenAI-compatible LLM
//   (school LLM "ax-local" by default). Keys stay in environment variables, never in the client.
//
// Env: PORT (default 8000), HOST (default 0.0.0.0), DEMO_DIST (default ./dist-demo)
//      AX_LLM_BASE_URL | OPENAI_BASE_URL, AX_LLM_API_KEY | OPENAI_API_KEY, AX_LLM_MODEL (default ax-local)
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const DIST = resolve(root, process.env.DEMO_DIST ?? "dist-demo");
const PORT = Number(process.env.PORT ?? 8000);
const HOST = process.env.HOST ?? "0.0.0.0";
const LLM_BASE_URL = (process.env.AX_LLM_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "").replace(/\/+$/, "");
const LLM_API_KEY = process.env.AX_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const LLM_MODEL = process.env.AX_LLM_MODEL ?? "ax-local";
const LLM_TIMEOUT_MS = Number(process.env.AX_LLM_TIMEOUT_MS ?? 22_000);
const MAX_BODY = 64 * 1024;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".otf": "font/otf", ".ttf": "font/ttf",
};
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "SAMEORIGIN",
};

const cache = new Map();
const rate = new Map();

function send(response, status, body, headers = {}) {
  response.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  response.end(body);
}

function sendJson(response, status, value) {
  send(response, status, JSON.stringify(value), { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
}

function rateLimited(ip) {
  const now = Date.now();
  const recent = (rate.get(ip) ?? []).filter(at => now - at < 60_000);
  recent.push(now);
  rate.set(ip, recent);
  return recent.length > 20;
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const SYSTEM_PROMPT = [
  "당신은 대학 신입생 세미나를 운영하는 교수를 돕는 수업 운영 비서 'Spark AI'입니다.",
  "입력은 한 분반의 팀별 활동 지표(JSON)입니다. 개인 이름은 없으며 모든 데이터는 시연용 가상 데이터입니다.",
  "입력에 없는 사실을 지어내지 말고, 숫자는 입력값을 그대로 사용하세요.",
  "반드시 아래 JSON 형식으로만 답하세요. 각 배열 항목은 한국어 한 문장(80자 이내)입니다.",
  '{"summary":["이번 주 요약 2~3개"],"attention":["주의가 필요한 팀: 이유와 근거 수치"],"questions":["학생들이 반복해서 묻는 주제와 팀"],"actions":["다음 수업 전 교수가 할 구체적 조치 3개"],"reminder":"필독 공지를 확인하지 않은 학생에게 보낼 친근한 2문장 안내","nudges":[{"team":"status가 attention인 팀 이름","message":"교수가 그 팀 채팅에 보낼 따뜻하고 구체적인 격려 2문장"}]}',
].join("\n");

function parseModelJson(text) {
  const cleaned = String(text ?? "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

async function callLlm(insights) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.3,
        max_tokens: 1300,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(insights) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw Object.assign(new Error(`LLM HTTP ${response.status}`), { status: 502 });
    const payload = await response.json();
    const briefing = parseModelJson(payload?.choices?.[0]?.message?.content);
    if (!briefing) throw Object.assign(new Error("LLM returned no JSON"), { status: 502 });
    return { briefing, model: payload?.model ?? LLM_MODEL, usage: payload?.usage ?? null };
  } finally {
    clearTimeout(timer);
  }
}

async function handleBriefing(request, response) {
  const ip = request.socket.remoteAddress ?? "unknown";
  if (rateLimited(ip)) return sendJson(response, 429, { error: "rate-limited" });
  if (!LLM_BASE_URL || !LLM_API_KEY) return sendJson(response, 503, { error: "llm-not-configured" });
  let body;
  try {
    body = JSON.parse(await readBody(request));
  } catch (error) {
    return sendJson(response, error.status ?? 400, { error: "invalid-body" });
  }
  if (body?.kind !== "class-briefing" || typeof body.insights !== "object") return sendJson(response, 400, { error: "invalid-kind" });
  const key = createHash("sha256").update(JSON.stringify(body.insights)).digest("hex");
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 10 * 60_000) return sendJson(response, 200, { ...cached.value, cached: true });
  try {
    const value = await callLlm(body.insights);
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    console.log(`[spark] briefing ok model=${value.model} tokens=${value.usage?.total_tokens ?? "?"}`);
    return sendJson(response, 200, value);
  } catch (error) {
    console.warn(`[spark] briefing failed: ${error.message}`);
    return sendJson(response, error.status ?? 502, { error: "llm-failed" });
  }
}

async function serveStatic(request, response) {
  const url = new URL(request.url, "http://localhost");
  const requested = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  let target = resolve(DIST, requested);
  if (target !== DIST && !target.startsWith(DIST + sep)) return send(response, 403, "Forbidden");
  try {
    if (!(await stat(target)).isFile()) throw new Error("not a file");
  } catch {
    target = join(DIST, "index.html");
  }
  try {
    const data = await readFile(target);
    const type = TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
    const immutable = target.includes(`${sep}assets${sep}`);
    send(response, 200, data, { "content-type": type, "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
  } catch {
    send(response, 404, "Not found");
  }
}

const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/api/health") return sendJson(response, 200, { ok: true, llm: Boolean(LLM_BASE_URL && LLM_API_KEY), model: LLM_MODEL });
  if (path === "/api/spark/briefing") {
    if (request.method !== "POST") return sendJson(response, 405, { error: "method-not-allowed" });
    return void handleBriefing(request, response);
  }
  if (path.startsWith("/api/")) return sendJson(response, 404, { error: "not-found" });
  if (!["GET", "HEAD"].includes(request.method)) return send(response, 405, "Method not allowed");
  return void serveStatic(request, response);
});

server.listen(PORT, HOST, () => {
  console.log(`STELLAR CONNECT demo server on http://${HOST}:${PORT} (dist: ${DIST}, llm: ${LLM_BASE_URL ? LLM_MODEL : "not configured"})`);
});
