// Meoo（秒悟）上游协议：设备授权登录、身份、积分、每日登录积分、模型目录。
//
// 端点与响应形状全部来自 meoo.com 的 CLI 兼容通道（与官方 meoo-cli 同一套），
// 参照 meoo2api（Go）的一手实测结论：
//
//   POST /api/v1/cli/auth/session                  → { sessionId }
//   GET  /api/v1/cli/auth/session/<id>             → { status, apiKey, userId, username }
//                                                    status: pending / approved / denied / expired
//   GET  /open/v1/cli-compat/account/identity      → 账号身份（Bearer 个人 AK）
//   GET  /open/v1/cli-compat/account/points        → { data.account.availableBalance }
//   GET  /meoo-ai/compatible-mode/v1/models        → 模型目录（项目 AK，api.meoo.host）
//
// 签到是网页侧的「每日登录积分」，**设备授权不返回网页 Cookie**（meoo2api 实测），
// 所以 Cookie 是可选补充凭证：有它才签到，没有就明确说签到不可用，绝不假装成功。
//
//   GET  /api/mc/entitlement/init（Cookie）        → { dailyLoginGranted, dailyLoginGrantAmount,
//                                                    dailyLoginSkipReason, dailyLoginBalanceAfter }
//                                                    skipReason: ALREADY_GRANTED_TODAY = 今天已领

const ORIGIN = "https://meoo.com";
const GATEWAY = "https://api.meoo.host/meoo-ai/compatible-mode/v1";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const CLIENT_HEADERS = { "X-Meoo-Client": "cli" };

export class MeooError extends Error {
  constructor(message, { status, signIn } = {}) {
    super(message);
    this.name = "MeooError";
    if (status) this.status = status;
    if (signIn) this.signIn = signIn;
  }
}

const expired = (message = "Meoo 登录已失效，请重新授权") =>
  new MeooError(message, { signIn: "expired", status: 401 });
export { expired };

// magpie 在插件作用域里可能替换全局 fetch（返回它自己的响应形状，不一定有
// .text()/.json()），所以读写响应体要两条路都兼容：标准 Response 用 text()，
// 异形对象就直接看有没有 json()/body 字段。
async function responseText(res) {
  if (res && typeof res.text === "function") return res.text();
  if (res && typeof res.json === "function") {
    const body = await res.json();
    return typeof body === "string" ? body : JSON.stringify(body);
  }
  if (res && typeof res.body === "string") return res.body;
  return JSON.stringify(res ?? {});
}

async function readJson(res) {
  const text = await responseText(res);
  try {
    return JSON.parse(text);
  } catch {
    throw new MeooError(`上游返回的不是 JSON（HTTP ${res.status}）: ${text.slice(0, 120)}`, {
      status: res.status,
    });
  }
}

function assertOk(res, body, what) {
  if (res.status === 401 || res.status === 403) throw expired();
  const ok = res.ok && (body?.success === undefined || body?.success !== false);
  if (!ok) {
    const message = body?.error?.message || body?.message || `HTTP ${res.status}`;
    throw new MeooError(`${what}失败: ${message}`, { status: res.status });
  }
}

// ── 设备授权（个人 AK）────────────────────────────────────────────────

export async function deviceSessionCreate(fetchImpl = fetch) {
  const res = await fetchImpl(`${ORIGIN}/api/v1/cli/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...CLIENT_HEADERS },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readJson(res);
  assertOk(res, body, "创建授权会话");
  const sessionId = body?.data?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) {
    throw new MeooError("授权响应缺少 sessionId");
  }
  return sessionId;
}

export async function deviceSessionPoll(sessionId, fetchImpl = fetch) {
  const res = await fetchImpl(`${ORIGIN}/api/v1/cli/auth/session/${encodeURIComponent(sessionId)}`, {
    headers: CLIENT_HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readJson(res);
  assertOk(res, body, "查询授权状态");
  const data = body?.data ?? {};
  const status = String(data.status || "pending");
  if (status === "approved") {
    if (typeof data.apiKey !== "string" || !data.apiKey) {
      throw new MeooError("授权响应缺少个人凭证");
    }
    return {
      status,
      apiKey: data.apiKey,
      userId: String(data.userId || ""),
      username: String(data.username || ""),
    };
  }
  if (!["pending", "expired", "denied"].includes(status)) {
    throw new MeooError(`授权响应状态无效: ${status}`);
  }
  return { status };
}

export const loginPageUrl = (sessionId) => `${ORIGIN}/cli/login?session_id=${encodeURIComponent(sessionId)}`;

// ── 已登录账号的读取（个人 AK）───────────────────────────────────────

function bearer(ak, extra = {}) {
  return { Authorization: `Bearer ${ak}`, ...CLIENT_HEADERS, ...extra };
}

// 身份：优先 CLI 兼容通道；网页 Cookie 只用于识别（不用于签到之外的地方）。
export async function identity(ak, { cookie = "" } = {}, fetchImpl = fetch) {
  const res = await fetchImpl(`${ORIGIN}/open/v1/cli-compat/account/identity`, {
    headers: cookie ? { ...bearer(ak), Cookie: cookie } : bearer(ak),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readJson(res);
  if (res.status === 401 || res.status === 403) throw expired();
  if (!res.ok) throw new MeooError(`身份读取失败: HTTP ${res.status}`, { status: res.status });
  return body?.data ?? body ?? {};
}

// 积分余额（个人 AK）。
export async function points(ak, fetchImpl = fetch) {
  const res = await fetchImpl(`${ORIGIN}/open/v1/cli-compat/account/points`, {
    headers: bearer(ak),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readJson(res);
  assertOk(res, body, "积分查询");
  const value = Number(body?.data?.account?.availableBalance);
  return Number.isFinite(value) ? value : null;
}

// 积分批次明细（网页 Cookie）：`GET /api/mc/entitlement/get` 的
// userPointInfo.activeGrants 按来源分类（SUBSCRIPTION / DAILY_LOGIN /
// INVITE_REWARD…），每类下 grantDetails[] 给剩余量与 expiresDate。
// 实测（2026-11-15）：每日登录积分有效期 **7 天**（不是当天作废），
// 订阅/邀请奖励跟随周期（当前周期结束日过期）。
export async function pointGrants(cookie, fetchImpl = fetch) {
  const res = await fetchImpl(`${ORIGIN}/api/mc/entitlement/get`, {
    headers: {
      Cookie: String(cookie || ""),
      Referer: `${ORIGIN}/`,
      Accept: "application/json",
      "User-Agent": UA,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) throw expired();
  const body = await readJson(res);
  const grants = body?.data?.userPointInfo?.activeGrants;
  if (!Array.isArray(grants)) return [];
  const out = [];
  for (const g of grants) {
    const source = String(g?.sourceType || "OTHER");
    const name = String(g?.sourceTypeName || source);
    for (const gd of Array.isArray(g?.grantDetails) ? g.grantDetails : []) {
      const remaining = Number(gd?.remainingAmount);
      const expires = String(gd?.expiresDate || "");
      if (!Number.isFinite(remaining) || remaining <= 0) continue;
      out.push({ source, name, remaining, ...(expires ? { expires } : {}) });
    }
  }
  return out;
}

// ── 每日登录积分（网页 Cookie）───────────────────────────────────────

// 结果三种：{ granted: true, amount, balanceAfter } / { granted: false, already: true }
// / { granted: false, unsupported: true }。Cookie 为空直接 unsupported，绝不请求。
export async function dailyLogin(auth, fetchImpl = fetch) {
  const cookie = String(auth?.cookie || "").trim();
  if (!cookie) return { granted: false, unsupported: true };

  const res = await fetchImpl(`${ORIGIN}/api/mc/entitlement/init`, {
    headers: {
      Cookie: cookie,
      Accept: "application/json",
      Referer: `${ORIGIN}/`,
      "User-Agent": UA,
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401 || res.status === 403) throw expired("Meoo 网页 Cookie 已失效，请补充新 Cookie");
  // 登录页重定向 = Cookie 不再是登录态。
  if (res.status >= 300 && res.status < 400) throw expired("Meoo 网页 Cookie 已失效（被重定向到登录页），请补充新 Cookie");
  const body = await readJson(res);
  if (!res.ok || body?.success === false) {
    const message = body?.error?.message || `HTTP ${res.status}`;
    throw new MeooError(`每日积分领取失败: ${message}`, { status: res.status });
  }
  const data = body?.data ?? {};
  const amount = Number(data.dailyLoginGrantAmount);
  const balance = Number(data.dailyLoginBalanceAfter);
  return {
    granted: data.dailyLoginGranted === true,
    already: data.dailyLoginSkipReason === "ALREADY_GRANTED_TODAY",
    ...(Number.isFinite(amount) ? { amount } : {}),
    ...(Number.isFinite(balance) ? { balanceAfter: balance } : {}),
  };
}

// ── 项目 AK（调模型网关的凭证）───────────────────────────────────────
//
// 个人 AK 管不了网关；项目 AK 在项目的云服务环境里。完整流程（meoo2api 实测）：
//   1. 已有项目直接读：GET /open/v1/cli-compat/projects?page=1&page_size=20
//      （只认本人创建、service_access enabled 且 ak_status=active 的）
//   2. 没有就建：POST /open/v1/cli-compat/projects { name, type: "create-desktop" }
//      → data.url_id
//   3. 开通云服务：POST .../projects/<url_id>/cloud（409 = 已开通，也算成功）
//   4. 读凭证：GET .../projects/<url_id>/cloud/environment
//      → data.meooProjectApiKey；云服务异步开通中会暂时拿不到，退避重试几次。
//   云额度满（QUOTA_EXCEEDED）时：只读地找本人已有的可用项目复用环境凭证，
//   绝不删除或改动远端项目。

const CLI = "/open/v1/cli-compat";

async function cliGet(fetchImpl, path, ak, what) {
  const res = await fetchImpl(`${ORIGIN}${CLI}${path}`, {
    headers: bearer(ak),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await readJson(res);
  if (res.status === 401 || res.status === 403) throw expired();
  if (!res.ok) throw new MeooError(`${what}失败: HTTP ${res.status}`, { status: res.status });
  return body?.data ?? {};
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 本人名下可复用的项目（service_access 已激活），取第一个能读到凭证的。
async function reusableProjectAk(fetchImpl, ak, userId) {
  if (!userId) return null;
  let list = [];
  try {
    const data = await cliGet(fetchImpl, "/projects?page=1&page_size=20", ak, "读取已有项目");
    list = Array.isArray(data?.list) ? data.list : [];
  } catch {
    return null; // 列表读不出不算失败，交给正常开通流程
  }
  let seen = 0;
  for (const p of list) {
    if (seen >= 10) break;
    const urlId = String(p?.url_id || "");
    const access = p?.custom_conf?.service_access ?? {};
    if (!urlId || String(p?.creator_user_id || "") !== userId) continue;
    if (access?.enabled !== true || String(access?.ak_status || "") !== "active") continue;
    seen += 1;
    try {
      const env = await cliGet(fetchImpl, `/projects/${encodeURIComponent(urlId)}/cloud/environment`, ak, "读取项目凭证");
      const key = String(env?.meooProjectApiKey || "");
      if (key) return { project: urlId, projectAk: key };
    } catch {
      // 这个项目读不出凭证就换下一个
    }
  }
  return null;
}

export async function ensureProjectAk(auth, fetchImpl = fetch) {
  const ak = String(auth?.apiKey || "");
  const userId = String(auth?.userId || "");
  if (!ak) throw expired();
  if (auth?.projectAk) return { projectAk: auth.projectAk, project: auth.project || "", reused: true };

  // 1) 已开通的项目直接复用（省一次云额度）
  const reusable = await reusableProjectAk(fetchImpl, ak, userId).catch(() => null);
  if (reusable) return { ...reusable, reused: true };

  // 2) 建项目（POST；name 用账号尾号便于人在控制台认出）
  const name = `magpie-meoo-${userId.slice(-4) || "x"}`;
  const createRes = await fetchImpl(`${ORIGIN}${CLI}/projects`, {
    method: "POST",
    headers: { ...bearer(ak), "Content-Type": "application/json" },
    body: JSON.stringify({ name, type: "create-desktop" }),
    signal: AbortSignal.timeout(20_000),
  });
  const createdBody = await readJson(createRes);
  if (createRes.status === 401 || createRes.status === 403) throw expired();
  const biz = String(createdBody?.error?.code || createdBody?.code || "");
  if (biz === "QUOTA_EXCEEDED") {
    // 云额度满：只读地找本人已有项目复用，找不到就把原始错误抛出去
    const fallback = await reusableProjectAk(fetchImpl, ak, userId).catch(() => null);
    if (fallback) return { ...fallback, reused: true };
    throw new MeooError("Meoo 云服务额度已满，且没有可复用的已开通项目");
  }
  if (!createRes.ok) {
    throw new MeooError(`建项目失败: HTTP ${createRes.status}`, { status: createRes.status });
  }
  const project = String(createdBody?.data?.url_id || "");
  if (!project) throw new MeooError("建项目响应缺少 url_id");

  // 3) 开通云服务（409 = 已开通）
  const cloudRes = await fetchImpl(`${ORIGIN}${CLI}/projects/${encodeURIComponent(project)}/cloud`, {
    method: "POST",
    headers: { ...bearer(ak), "Content-Type": "application/json" },
    body: JSON.stringify({ description: `${name} cloud` }),
    signal: AbortSignal.timeout(30_000),
  });
  await readJson(cloudRes).catch(() => ({}));
  if (cloudRes.status === 401 || cloudRes.status === 403) throw expired();
  if (![200, 201, 409].includes(cloudRes.status)) {
    throw new MeooError(`开通云服务失败: HTTP ${cloudRes.status}`, { status: cloudRes.status });
  }

  // 4) 读凭证（云服务异步初始化，退避重试；间隔可通过 opts 传 0 便于测试）
  const delay = typeof ensureProjectAk.retryDelayMs === "number" ? ensureProjectAk.retryDelayMs : 2000;
  const tries = typeof ensureProjectAk.tries === "number" ? ensureProjectAk.tries : 5;
  let lastError = null;
  for (let attempt = 0; attempt <= tries; attempt += 1) {
    if (attempt > 0) await sleepMs(delay);
    try {
      const env = await cliGet(fetchImpl, `/projects/${encodeURIComponent(project)}/cloud/environment`, ak, "读取项目凭证");
      const key = String(env?.meooProjectApiKey || "");
      if (key) return { project, projectAk: key, reused: false };
      lastError = new MeooError("项目凭证尚未生成（云服务初始化中）");
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new MeooError("读取项目凭证失败");
}

// ── Cookie 登录（网页会话 → 全套凭证一步到位）────────────────────────

// 网页 Cookie 验身份 + 建个人 AK（meoo2api 实测：POST /api/v1/user/api-keys）。
// Cookie 本身就是签到凭据 —— 一次粘贴，登录/调模型/签到三件事全就位。
export async function loginByCookie(cookie, fetchImpl = fetch) {
  const jar = String(cookie || "").trim();
  if (!jar) throw new MeooError("没有输入 Cookie");
  const webHeaders = { Cookie: jar, Referer: `${ORIGIN}/`, Accept: "application/json", "User-Agent": UA };

  // 1) 验身份（GET /api/v1/user/me）。⚠ 未登录时上游也回 200，但
  //    data 为 null 并给 redirectUrl —— data 非空才算登录态。
  const meRes = await fetchImpl(`${ORIGIN}/api/v1/user/me`, {
    headers: webHeaders, redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  if (meRes.status === 401 || meRes.status === 403) throw expired("Cookie 无效或已过期（未登录态）");
  if (meRes.status >= 300 && meRes.status < 400) throw expired("Cookie 无效（被重定向到登录页）");
  const meBody = await readJson(meRes);
  if (!meRes.ok) throw new MeooError(`身份验证失败: HTTP ${meRes.status}`, { status: meRes.status });
  const me = meBody?.data ?? {};
  const redirectUrl = String(meBody?.redirectUrl || "");
  const userId = String(me?.userId || me?.id || me?.user_id || "");
  const username = String(me?.username || me?.nickname || me?.name || "");
  if (!userId) {
    if (redirectUrl || meBody?.data === null) throw expired("Cookie 不是登录态（页面未登录）");
    throw new MeooError("Cookie 有效但响应里没有 userId（页面结构变了？）");
  }

  // 2) 建个人 AK（有了它 magpie 才能查积分/读身份/开项目；模型走项目 AK）。
  //    scopes 必须给全量词表（meoo2api 的 AllScopes）—— 传 ["all"] 会建出
  //    缺 cli.compat 的残废 AK，查积分/开项目全部 403 insufficient_scope。
  const keyRes = await fetchImpl(`${ORIGIN}/api/v1/user/api-keys`, {
    method: "POST",
    headers: { ...webHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "magpie-meoo",
      description: "created by magpie-meoo",
      scopes: [
        "cli.compat", "project.read", "project.write", "cloud.read", "cloud.write",
        "cloud.credentials.read", "cloud.database.read", "cloud.function.read",
        "credit.read", "entitlement.read", "user.read", "release.read", "source.read",
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const keyBody = await readJson(keyRes).catch(() => ({}));
  let apiKey = String(keyBody?.data?.apiKey || "");
  if (!apiKey && (keyRes.status === 400 || keyRes.status === 422)) {
    // scopes 词表上游改过时退回不带 scopes 再试（上游会给默认集）
    const retry = await fetchImpl(`${ORIGIN}/api/v1/user/api-keys`, {
      method: "POST",
      headers: { ...webHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "magpie-meoo" }),
      signal: AbortSignal.timeout(30_000),
    });
    apiKey = String((await readJson(retry).catch(() => ({})))?.data?.apiKey || "");
  }
  if (!apiKey) {
    // AK 建不了不挡登录：Cookie 仍可签到，模型可后续手动补
    return { userId, username, cookie: jar, apiKey: "" };
  }
  return { userId, username, cookie: jar, apiKey };
}

// ── 模型目录（项目 AK）───────────────────────────────────────────────

export async function modelCatalog(projectAk, fetchImpl = fetch) {
  const res = await fetchImpl(`${GATEWAY}/models`, {
    headers: { Authorization: `Bearer ${projectAk}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) throw expired();
  const body = await readJson(res);
  // 上游实测两种形状：OpenAI 的 {data:[{id}]} 和 meoo 自己的
  // {models:["id",…], defaultModel}（2026-11 实测后者）。
  const rows = Array.isArray(body?.data) ? body.data : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const id = String(row?.id ?? row?.key ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: String(row?.name || row?.display_name || id) });
  }
  for (const id of Array.isArray(body?.models) ? body.models : []) {
    const key = String(id ?? "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: key, name: key });
  }
  return out;
}

export const _internal = {
  ORIGIN,
  GATEWAY,
  CLI,
  dailyLogin,
  deviceSessionCreate,
  deviceSessionPoll,
  ensureProjectAk,
  identity,
  loginByCookie,
  loginPageUrl,
  modelCatalog,
  pointGrants,
  points,
  reusableProjectAk,
};
