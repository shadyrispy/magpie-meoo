// Meoo 协议层与插件接入的单测（网络全打桩）。
import test from "node:test"
import assert from "node:assert/strict"

import { MeooAuthPlugin, _internal } from "../index.mjs"
import { _internal as meoo } from "../src/meoo.mjs"

const snapshot = (patch = {}) =>
  JSON.stringify({ apiKey: "meoo_ak_test", userId: "u-1", username: "tester", ...patch })

// 打桩 fetch：按 URL 前缀路由。
function serve(routes) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, init })
    for (const [match, handler] of routes) {
      if (u.includes(match)) return handler(u, init)
    }
    return new Response("not found", { status: 404 })
  }
  return { calls, fetch }
}

test("snapshot 解析：合法/非法/裸值", () => {
  assert.equal(_internal.snapshotOf({ access: snapshot() }).apiKey, "meoo_ak_test")
  assert.equal(_internal.snapshotOf({ access: "not-json" }), null)
  assert.equal(_internal.snapshotOf({ access: "{}" }), null, "缺 apiKey 的 JSON 不是有效快照")
  assert.equal(_internal.snapshotOf({ access: "dwc1.xxx" }), null)
})

test("dailyLogin：granted / ALREADY_GRANTED_TODAY / 无 Cookie 三分支", async () => {
  const granted = serve([
    ["/api/mc/entitlement/init", () =>
      Response.json({ success: true, data: { dailyLoginGranted: true, dailyLoginGrantAmount: 100, dailyLoginBalanceAfter: 5300 } })],
  ])
  const r1 = await meoo.dailyLogin({ cookie: "sessionid=x" }, granted.fetch)
  assert.equal(r1.granted, true)
  assert.equal(r1.amount, 100)
  assert.equal(r1.balanceAfter, 5300)
  assert.ok(granted.calls[0].init.headers.Cookie.includes("sessionid=x"))
  assert.equal(granted.calls[0].init.headers.Referer, "https://meoo.com/")

  const already = serve([
    ["/api/mc/entitlement/init", () =>
      Response.json({ success: true, data: { dailyLoginGranted: false, dailyLoginSkipReason: "ALREADY_GRANTED_TODAY" } })],
  ])
  const r2 = await meoo.dailyLogin({ cookie: "sessionid=x" }, already.fetch)
  assert.equal(r2.granted, false)
  assert.equal(r2.already, true)

  const r3 = await meoo.dailyLogin({}, async () => { throw new Error("should not fetch") })
  assert.equal(r3.unsupported, true, "没有 Cookie 就不请求，明确说不可用")
})

test("dailyLogin：Cookie 失效（401 / 登录页重定向）→ signIn expired", async () => {
  const s401 = serve([["/api/mc/entitlement/init", () => new Response("{}", { status: 401 })]])
  await assert.rejects(() => meoo.dailyLogin({ cookie: "x" }, s401.fetch), (e) => e.signIn === "expired")

  const s302 = serve([
    ["/api/mc/entitlement/init", () => new Response(null, { status: 302, headers: { location: "https://meoo.com/login" } })],
  ])
  await assert.rejects(() => meoo.dailyLogin({ cookie: "x" }, s302.fetch), (e) => e.signIn === "expired")
})

test("设备授权：create → poll pending → approved 带个人 AK", async () => {
  let pollCount = 0
  const net = serve([
    ["/api/v1/cli/auth/session", (url, init) => {
      if (init.method === "POST") {
        return Response.json({ success: true, data: { sessionId: "sid-1" } })
      }
      pollCount += 1
      return Response.json({
        success: true,
        data: pollCount < 2
          ? { status: "pending" }
          : { status: "approved", apiKey: "meoo_ak_new", userId: "u-9", username: "newcomer" },
      })
    }],
  ])
  const sid = await meoo.deviceSessionCreate(net.fetch)
  assert.equal(sid, "sid-1")
  assert.equal(meoo.loginPageUrl(sid), "https://meoo.com/cli/login?session_id=sid-1")

  const p1 = await meoo.deviceSessionPoll(sid, net.fetch)
  assert.equal(p1.status, "pending")
  const p2 = await meoo.deviceSessionPoll(sid, net.fetch)
  assert.equal(p2.status, "approved")
  assert.equal(p2.apiKey, "meoo_ak_new")
  assert.equal(p2.userId, "u-9")
})

test("插件 checkin：无 Cookie → inactive（不是假装成功）；已领 → done；新领 → claimed", async () => {
  const noCookie = serve([["/api/mc/entitlement/init", () => { throw new Error("不该请求") }]])
  const plugin0 = await MeooAuthPlugin({}, { fetchImpl: noCookie.fetch })
  const out0 = await plugin0.auth.checkin(
    async () => ({ type: "oauth", access: snapshot() }),
    { id: "meoo" },
  )
  assert.equal(out0.outcome, "inactive")
  assert.match(out0.message, /Cookie/)

  const already = serve([
    ["/api/mc/entitlement/init", () =>
      Response.json({ success: true, data: { dailyLoginGranted: false, dailyLoginSkipReason: "ALREADY_GRANTED_TODAY", dailyLoginBalanceAfter: 5300 } })],
  ])
  const withCookie = snapshot({ cookie: "sessionid=abc" })
  const plugin1 = await MeooAuthPlugin({}, { fetchImpl: already.fetch })
  const out1 = await plugin1.auth.checkin(async () => ({ type: "oauth", access: withCookie }), { id: "meoo" })
  assert.equal(out1.outcome, "done")

  const fresh = serve([
    ["/api/mc/entitlement/init", () =>
      Response.json({ success: true, data: { dailyLoginGranted: true, dailyLoginGrantAmount: 100, dailyLoginBalanceAfter: 5400 } })],
  ])
  const plugin2 = await MeooAuthPlugin({}, { fetchImpl: fresh.fetch })
  const out2 = await plugin2.auth.checkin(async () => ({ type: "oauth", access: withCookie }), { id: "meoo" })
  assert.equal(out2.outcome, "claimed")
  assert.equal(out2.credit, 100)
  assert.ok(!JSON.stringify(out2).includes("sessionid=abc"), "Cookie 不出现在返回里")
})

test("usage：积分是钱包型余额（无上限窗口）", async () => {
  const net = serve([
    ["/open/v1/cli-compat/account/points", () =>
      Response.json({ success: true, data: { account: { availableBalance: 5300 } } })],
    ["/open/v1/cli-compat/account/identity", () =>
      Response.json({ success: true, data: { userId: "u-1", username: "tester" } })],
  ])
  const plugin = await MeooAuthPlugin({}, { fetchImpl: net.fetch })
  const u = await plugin.auth.usage(
    async () => ({ type: "oauth", access: snapshot() }),
    { id: "meoo" },
  )
  assert.equal(u.plan, "Meoo")
  assert.equal(u.user, "tester")
  assert.equal(u.windows.length, 1)
  assert.equal(u.windows[0].name, "积分")
  assert.equal(u.windows[0].balance, 5300)
  assert.ok(!JSON.stringify(u).includes("meoo_ak_test"), "AK 不出现在 usage 返回里")
})

test("ensureProjectAk：已有可用项目直接复用（不建新的）", async () => {
  const net = serve([
    ["/open/v1/cli-compat/projects?page=1", () =>
      Response.json({ success: true, data: { list: [
        { url_id: "proj-1", creator_user_id: "u-1", custom_conf: { service_access: { enabled: true, ak_status: "active" } } },
        { url_id: "proj-2", creator_user_id: "someone-else", custom_conf: { service_access: { enabled: true, ak_status: "active" } } },
      ] } })],
    ["/projects/proj-1/cloud/environment", () =>
      Response.json({ success: true, data: { meooProjectApiKey: "meoo_project_k1" } })],
    ["/api/v1/cli/auth/session", () => { throw new Error("不该建新项目") }],
  ])
  const got = await meoo.ensureProjectAk({ apiKey: "meoo_ak_x", userId: "u-1" }, net.fetch)
  assert.equal(got.project, "proj-1")
  assert.equal(got.projectAk, "meoo_project_k1")
  assert.equal(got.reused, true)
  assert.ok(!net.calls.some((c) => c.init?.method === "POST" && c.url.includes("/projects") && !c.url.includes("environment")), "没有 POST 建项目")
})

test("ensureProjectAk：无项目 → 建项目 → 开通云（409 已开通也算）→ 轮询凭证", async () => {
  meoo.ensureProjectAk.retryDelayMs = 0
  meoo.ensureProjectAk.tries = 3
  let envTries = 0
  const net = serve([
    ["/projects/proj-new/cloud/environment", () => {
      envTries += 1
      return Response.json({ success: true, data: envTries >= 2 ? { meooProjectApiKey: "meoo_project_k2" } : {} })
    }],
    ["/projects?page=1", () => Response.json({ success: true, data: { list: [] } })],
    ["/open/v1/cli-compat/projects", (url, init) => {
      if (init.method === "POST") return Response.json({ success: true, data: { url_id: "proj-new" } })
      return Response.json({ success: true, data: { list: [] } })
    }],
    ["/projects/proj-new/cloud", (url, init) => {
      if (init.method === "POST") return new Response("{}", { status: 409 })
      return Response.json({ success: true, data: {} })
    }],
  ])
  const got = await meoo.ensureProjectAk({ apiKey: "meoo_ak_x", userId: "u-1" }, net.fetch)
  assert.equal(got.project, "proj-new")
  assert.equal(got.projectAk, "meoo_project_k2")
  assert.equal(got.reused, false)
  assert.ok(envTries >= 2, "凭证异步生成时有重试")
})

test("ensureProjectAk：云额度满且无可复用项目 → 明确报错", async () => {
  const net = serve([
    ["/open/v1/cli-compat/projects", (url, init) => {
      if (init.method === "POST") {
        return Response.json({ success: false, error: { code: "QUOTA_EXCEEDED", message: "云实例额度已满" } }, { status: 200 })
      }
      return Response.json({ success: true, data: { list: [] } })
    }],
  ])
  await assert.rejects(
    () => meoo.ensureProjectAk({ apiKey: "meoo_ak_x", userId: "u-1" }, net.fetch),
    /额度已满/,
  )
})

test("loginByCookie：有效 Cookie → 身份 + AK + cookie 三件套", async () => {
  const net = serve([
    ["/api/v1/user/me", () => Response.json({ success: true, data: { userId: "u-7", username: "cookielover" } })],
    ["/api/v1/user/api-keys", (url, init) => {
      assert.ok(init.headers.Cookie.includes("acw_tc=WEB"), "建 AK 带整段 Cookie")
      return Response.json({ success: true, data: { apiKey: "meoo_ak_from_cookie" } })
    }],
  ])
  const t = await meoo.loginByCookie("acw_tc=WEB; SESSION=xyz", net.fetch)
  assert.equal(t.userId, "u-7")
  assert.equal(t.username, "cookielover")
  assert.equal(t.cookie, "acw_tc=WEB; SESSION=xyz")
  assert.equal(t.apiKey, "meoo_ak_from_cookie")
})

test("loginByCookie：401 / 重定向登录页 → expired", async () => {
  const s401 = serve([["/api/v1/user/me", () => new Response("{}", { status: 401 })]])
  await assert.rejects(() => meoo.loginByCookie("x", s401.fetch), (e) => e.signIn === "expired")
  const s302 = serve([["/api/v1/user/me", () => new Response(null, { status: 302, headers: { location: "/login" } })]])
  await assert.rejects(() => meoo.loginByCookie("x", s302.fetch), (e) => e.signIn === "expired")
})

test("loginByCookie：AK 建不了不挡登录（Cookie 照样入账，签到可用）", async () => {
  const net = serve([
    ["/api/v1/user/me", () => Response.json({ success: true, data: { userId: "u-8", username: "nokey" } })],
    ["/api/v1/user/api-keys", () => new Response("{}", { status: 403 })],
  ])
  const t = await meoo.loginByCookie("SESSION=abc", net.fetch)
  assert.equal(t.userId, "u-8")
  assert.equal(t.apiKey, "")
  assert.equal(t.cookie, "SESSION=abc")
})
