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
const LLM_TIMEOUT_MS = Number(process.env.AX_LLM_TIMEOUT_MS ?? 70_000);
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
  "Reasoning: low",
  "당신은 대학 신입생 세미나를 운영하는 교수를 돕는 수업 운영 비서 'Spark AI'입니다.",
  "입력은 한 분반의 팀별 활동 지표(JSON)입니다. 개인 이름은 없으며 모든 데이터는 시연용 가상 데이터입니다.",
  "입력에 없는 사실을 지어내지 말고, 숫자와 팀 이름은 입력값을 그대로 쓰세요.",
  "생각 과정은 쓰지 말고, 설명 없이 JSON 객체 하나만 바로 출력하세요.",
  "JSON 키와 내용:",
  "- summary: 이번 주 분반 상황 요약 문장 2~3개 (참여율 변화, 가장 낮은 공지 확인률, 설문 결과 포함)",
  "- attention: 주의가 필요한 팀마다 '팀 이름: 이유(근거 수치)' 형식 문장",
  "- questions: 학생들이 반복해서 묻는 주제와 해당 팀 문장",
  "- actions: 교수가 다음 수업 전에 할 구체적 조치 문장 3개",
  "- reminder: 필독 공지를 아직 확인하지 않은 학생에게 보낼 친근한 2문장, 존댓말(해요체) (문자열)",
  "- nudges: status가 attention인 팀마다 {team: 팀 이름, message: 교수가 그 팀 채팅에 보낼 따뜻하고 구체적인 격려 2문장. '팀 이름 여러분,'으로 시작하고 존댓말(해요체)로 씁니다}",
  "모든 항목은 짧은 한국어 한 문장입니다. 글자 수를 세지 마세요.",
].join("\n");
const TEMPLATE_ECHO = /이번 주 요약 2~3개|이유와 근거 수치|status가 attention인 팀 이름|구체적 조치 3개/;

// Local models often wrap JSON in reasoning tags, code fences, prose or trailing commas. Be forgiving.
export function parseModelJson(text) {
  const cleaned = String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*<\/think>/i, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/[“”]/g, '"')
    .trim();
  const attempts = [];
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) attempts.push(cleaned.slice(start, end + 1));
  const blocks = [];
  for (let index = 0; index < cleaned.length; index += 1) {
    if (cleaned[index] !== "{") continue;
    let depth = 0;
    let inString = false;
    for (let cursor = index; cursor < cleaned.length; cursor += 1) {
      const character = cleaned[cursor];
      if (character === '"' && cleaned[cursor - 1] !== "\\") inString = !inString;
      if (inString) continue;
      if (character === "{") depth += 1;
      if (character === "}" && --depth === 0) {
        blocks.push(cleaned.slice(index, cursor + 1));
        break;
      }
    }
  }
  // The final answer comes after any reasoning, so try the last blocks first.
  attempts.unshift(...blocks.reverse());
  for (const candidate of attempts) {
    for (const variant of [candidate, candidate.replace(/,\s*([}\]])/g, "$1")]) {
      try {
        const parsed = JSON.parse(variant);
        const value = parsed?.briefing && typeof parsed.briefing === "object" ? parsed.briefing : parsed;
        if (value && typeof value === "object" && (value.summary || value.actions) && !TEMPLATE_ECHO.test(JSON.stringify(value))) return value;
      } catch { /* try the next candidate */ }
    }
  }
  return null;
}

async function requestCompletion(insights, { jsonMode, lowReasoning }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    return await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.3,
        max_tokens: 3500,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        ...(lowReasoning ? { reasoning_effort: "low" } : {}),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `${JSON.stringify(insights)}\n\n/no_think` },
        ],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function callLlm(insights) {
  let response = await requestCompletion(insights, { jsonMode: true, lowReasoning: true });
  if (response.status === 400 || response.status === 422) {
    console.warn(`[spark] optional parameters rejected (HTTP ${response.status}); retrying without them`);
    response = await requestCompletion(insights, { jsonMode: false, lowReasoning: false });
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300).replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");
    throw Object.assign(new Error(`LLM HTTP ${response.status}: ${detail}`), { status: 502, reason: `http-${response.status}` });
  }
  const payload = await response.json();
  const message = payload?.choices?.[0]?.message ?? {};
  const content = message.content || message.reasoning_content || "";
  const finish = payload?.choices?.[0]?.finish_reason ?? "unknown";
  const briefing = parseModelJson(content);
  if (!briefing) {
    const text = String(content);
    console.warn(`[spark] unparsable model output (${text.length} chars, finish=${finish}): ${text.slice(0, 400).replace(/\s+/g, " ")}`);
    // Model output is about virtual demo data only; a short excerpt helps diagnose format problems.
    throw Object.assign(new Error("LLM returned no JSON"), {
      status: 502,
      reason: `unparsable-output-${text.length}-finish-${finish}`,
      sample: `${text.slice(0, 500)}\n…\n${text.slice(-300)}`,
    });
  }
  return { briefing, model: payload?.model ?? LLM_MODEL, usage: payload?.usage ?? null, finish, chars: String(content).length };
}

const CACHE_TTL_MS = 60 * 60_000;
const MAX_CONCURRENT_LLM = 4;
const inflight = new Map();

function clientKey(request) {
  // Behind the AX proxy every visitor shares the socket address; use the forwarded client address.
  const forwarded = String(request.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return forwarded || request.headers["x-real-ip"] || request.socket.remoteAddress || "unknown";
}

async function handleBriefing(request, response) {
  if (!LLM_BASE_URL || !LLM_API_KEY) return sendJson(response, 503, { error: "llm-not-configured" });
  let body;
  try {
    body = JSON.parse(await readBody(request));
  } catch (error) {
    return sendJson(response, error.status ?? 400, { error: "invalid-body" });
  }
  if (body?.kind !== "class-briefing" || typeof body.insights !== "object") return sendJson(response, 400, { error: "invalid-kind" });
  const key = createHash("sha256").update(JSON.stringify(body.insights)).digest("hex");
  // Cached and in-flight answers cost nothing, so they are served before any rate limit.
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return sendJson(response, 200, { ...cached.value, cached: true });
  let job = inflight.get(key);
  if (!job) {
    if (rateLimited(clientKey(request))) return sendJson(response, 429, { error: "rate-limited" });
    if (inflight.size >= MAX_CONCURRENT_LLM) return sendJson(response, 503, { error: "llm-busy", reason: "busy" });
    job = callLlm(body.insights).finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  try {
    const value = await job;
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    console.log(`[spark] briefing ok model=${value.model} tokens=${value.usage?.total_tokens ?? "?"}`);
    return sendJson(response, 200, value);
  } catch (error) {
    console.warn(`[spark] briefing failed: ${error.message}`);
    const reason = error.reason ?? (error.name === "AbortError" ? "timeout" : "network");
    return sendJson(response, error.status ?? 502, { error: "llm-failed", reason, ...(error.sample ? { sample: error.sample } : {}) });
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
    // Missing build files must 404 (never fall back to HTML), or a stale page shows a blank screen.
    if (/\.[a-z0-9]{2,5}$/i.test(requested)) return send(response, 404, "Not found", { "cache-control": "no-store" });
    target = join(DIST, "index.html");
  }
  try {
    const data = await readFile(target);
    const type = TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
    const immutable = target.includes(`${sep}assets${sep}`);
    send(response, 200, data, { "content-type": type, "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store" });
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
