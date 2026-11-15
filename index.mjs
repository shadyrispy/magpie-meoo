// magpie 插件完整模板
//
// 九项全实现，一项不缺。复制后改 PROVIDER / BASE / 各 TODO 即可。
//
// ⚠ 这份模板是**一个供应商**的形态。如果同一厂商有国内 / 国际两套云、
//   而且必须是 magpie 里的两张卡（两组登录态并存），别在这份上打补丁 ——
//   照 MULTI-PROVIDER.md 的 makePlugin(SITE) 骨架重写，五条铁律照抄。
//
// ═══════════════════════════════════════════════════════════════════════
// 九项清单
// ═══════════════════════════════════════════════════════════════════════
//
//  钩子（magpie 会调）
//   ① config(cfg)                     声明 provider + 静态模型表
//   ② auth.methods[].authorize()      登录
//   ③ auth.refresh(auth, provider)    续期
//   ④ auth.loader(getAuth, provider)  请求接管
//   ⑤ auth.usage(getAuth, provider)   额度 → 卡片进度条
//   ⑥ auth.checkin(getAuth, provider) 签到
//   ⑦ provider.models(provider,{auth}) 每账号目录
//   ⑧ "chat.headers"(input, output)   每请求加头
//
//  数据字段（不是钩子但决定 UI）
//   ⑨ accountId / uid                 卡片显示名 + 同名区分
//      auth.icon / magpie.icon         卡片图标
//      auth.maxConcurrency             并发数
//
// ═══════════════════════════════════════════════════════════════════════
// 三条铁律
// ═══════════════════════════════════════════════════════════════════════
//
// 1. config.models 必须有内容 —— 未登录也要有，否则显示 "0 models"
// 2. authorize() 立刻返回 —— 真正等登录的是 callback()，否则和 magpie 死锁
// 3. refresh 返回的是合并 —— client.auth.set 是整体替换，两者不同
//
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// ⚠ 这是一个模板 —— 改完下面三行才有意义
// ═══════════════════════════════════════════════════════════════════════
//
//   PROVIDER        改成厂商自己的 id（agent 用 <id>/<model> 命名）
//   PROVIDER_NAME   供应商名 —— 必须 <中文> <English>，英文照抄厂商官方品牌写法
//                   （插件卡片标题是 package.json 的 name，同一套约定）
//   BASE            上游 API 基址
//
// 然后实现 index.mjs 底部的五个 TODO 函数。
//
// ═══════════════════════════════════════════════════════════════════════

// ── 额度窗口的构造器 ─────────────────────────────────────────────────
// 见 src/quota.mjs：它把「写错不报错、但 GUI 和智能路由会坏」的五类写法变成运行时错误。
// 派生仓库把 src/ 一起带走即可（GUIDE 第 1 步已写明）。
import { usage as buildUsage, usageWindow } from "./src/quota.mjs"
import { createRefreshLock } from "./src/refresh-lock.mjs"
import { createUsageCache } from "./src/usage-cache.mjs"
import { rewriteRefusal } from "./src/status.mjs"
import { uidOf } from "./src/credential.mjs"

// ── 配置 ──────────────────────────────────────────────────────────────

const PROVIDER = "meoo" // ⚠ 改成厂商 id，如 "huawei"
const PROVIDER_NAME = "秒悟 Meoo" // ⚠ 改成 <中文> <English>，英文照抄厂商官方写法
const BASE = "https://meoo.com"
const GATEWAY = "https://api.meoo.host/meoo-ai/compatible-mode/v1" // 模型网关（项目 AK 调用）
const SDK = "@ai-sdk/openai-compatible" // 决定 API 形状，见下表
const REFRESH_LEAD_MS = 5 * 60_000

// npm 包 → API 形状
//   @ai-sdk/anthropic        → Anthropic Messages  /messages
//   @ai-sdk/openai           → OpenAI Responses    /responses
//   @ai-sdk/google           → Gemini              /models/<id>:streamGenerateContent
//   @ai-sdk/openai-compatible → Chat completions   /chat/completions

// ── 模型表 ────────────────────────────────────────────────────────────

/**
 * [id, 显示名, 上下文窗口, 最大输出, 费率{输入,输出,缓存}, 多模态, reasoning]
 *
 * 费率来自官方 pricing.md 的「语言积分扣减标准」（积分 / 1k tokens），
 * 这里换算成 magpie 的 cost 口径（USD / 1M tokens）。Meoo 没公开积分→法币
 * 的兑换价，按官方新人首月 5000 积分 ≈ ¥15（Lite 月费 ¥29/20000 积分的
 * 每积分单价）折算：1 积分 ≈ ¥0.00145 ≈ $0.0002（2026-11 实测口径）。
 * 上下文/最大输出来自官方 models.md 的声明（未声明的用同系列值兜底）。
 * 实测工具调用（tool_calls）全部支持（qwen3.8-flash 一手验证，其余按系列）。
 */
const CREDIT_USD = 0.0002 // 1 积分 ≈ $0.0002（ Lite ¥29/月 ÷ 20000 积分 ÷ 汇率 ）
const perK = (n) => n * 1000 * CREDIT_USD // 积分/1k tokens → USD/1M tokens

const MODELS = [
  //                     id                          显示名                 上下文      最大输出  输入    输出   缓存   多模态  reasoning
  ["qwen3.8-flash", "Qwen3.8 Flash", 1_000_000, 65_536, 0.8, 2.7, 0.1, true, true],
  ["qwen3.8-max", "Qwen3.8 Max", 1_000_000, 65_536, 12, 36, 1, true, false],
  ["qwen3.7-max", "Qwen3.7 Max", 262_144, 65_536, 6, 18, 0.6, false, true],
  ["qwen3.7-plus", "Qwen3.7 Plus", 262_144, 65_536, 1.6, 6.4, 0.16, true, false],
  // qwen4-max-preview 不进表：目录里有但实测 403 Access denied（当前账号档位无权），
  // 放进来会被路由选中然后失败。上游放开权限后随实时目录自动出现。
  ["deepseek-v4.1-flash-1017", "DeepSeek V4.1 Flash", 1_000_000, 65_536, 2, 8, 0.2, true, false],
  ["deepseek-v4-pro-0813", "DeepSeek V4 Pro", 1_000_000, 384_000, 9, 27, 0.9, false, true],
  ["deepseek-v4-flash-0731", "DeepSeek V4 Flash", 1_000_000, 384_000, 3, 9, 0.3, false, true],
  ["glm-5.2", "GLM-5.2", 1_000_000, 65_536, 8, 28, 2, false, false],
  ["glm-5.2-fast-preview", "GLM-5.2 Fast Preview", 1_000_000, 65_536, 16, 56, 4, false, true],
]

/** 静态模型表（未登录 / 拉取失败时兜底） */
function staticModels() {
  const out = {}
  for (const [id, name, context, output, inRate, outRate, cacheRate, multimodal, reasoning] of MODELS) {
    out[id] = {
      id,
      name,
      api: { id, url: BASE, npm: SDK },
      status: "active",
      cost: {
        input: perK(inRate),
        output: perK(outRate),
        cache: { read: perK(cacheRate), write: 0 },
      },
      limit: { context, output },
      // config 钩子的静态模型走 modalities；capabilities.input 是 provider.models 路径的字段。
      // 两个都写，避免「只写 capabilities 而 config 路径读不到模态」。
      modalities: { input: ["text"], output: ["text"] },
      capabilities: {
        temperature: true,
        reasoning,
        toolcall: true, // 2026-11 实测：qwen3.8-flash 返回标准 tool_calls
        attachment: multimodal,
        // HOOKS 十一之三：五个模态键必须显式写布尔（省略 image ≠ text）
        input: { text: true, image: multimodal, audio: false, video: false, pdf: multimodal },
        output: { text: true },
      },
    }
  }
  return out
}

// ── 插件入口 ──────────────────────────────────────────────────────────

export const MeooAuthPlugin = async (_ctx, _options = {}) => {
  // 测试注入 fetch 走 _options（普通对象）。⚠ 不能用 _ctx.client.fetchImpl：
  // magpie 的 client 是 Proxy，未知字段返回 stub 函数（调用得 { data: undefined }，
  // 不是 Response），且读它的属性可能触发 Symbol.toPrimitive 异常。
  const http = typeof _options?.fetchImpl === "function" ? _options.fetchImpl : fetch
  // 同一 refresh_token 的并发续期合并成一次，成功后 60 秒内回放结果。
  // 键必须是凭据身份（refresh_token），不能用 provider id —— 同渠道多账号会串结果。
  const refreshLock = createRefreshLock({ replayMs: 60_000 })
  // 登录补任务与每日签到可能同时触发；同账号共享同一 Promise，不回放成功结果。
  const checkinLock = createRefreshLock({ replayMs: 0 })

  // 额度卡片会被频繁刷新：成功 60 秒、失败 5 秒，同 key 并发合并。
  // key 用凭据身份，不能用 provider id —— 同渠道多账号会串额度。
  const usageCache = createUsageCache({ ttlMs: 60_000, failTtlMs: 5_000 })

  // _ctx 是宿主给的上下文：{ client, directory, … }。
  // 打日志用 _ctx?.client?.app?.log?.({ service, level, message })。
  //
  // ⚠ 不要往 magpie 的目录里写任何东西（包括它自己的 ~/.cache/magpie/*.json）：
  //   那份文件属于 magpie。插件只读，不写。
  //   卡片标题、「源码」按钮、市场文案的载体是 registry 条目，见 registry-entry.json。

  return {

  // ═══ ① 声明 provider ══════════════════════════════════════════════
  config: async (cfg) => {
    cfg.provider ??= {}
    // ⚠ 用 ??= ，不要覆盖用户在 plugins.json 里配的
    cfg.provider[PROVIDER] ??= {
      name: PROVIDER_NAME,
      npm: SDK,
      api: BASE,
      models: staticModels(), // ⚠ 未登录时也必须有内容
    }
  },

  auth: {
    provider: PROVIDER,

    // ── 数据字段（不是钩子）────────────────────────────────────────
    // ⚠ 图标要写两份，缺一份就有地方显示灰方块：
    //   这里 auth.icon        → 供应商列表那一行、用量概览的卡
    //   package.json 的
    //     magpie.icon        → 插件列表那一行、插件详情页左上角
    //   两处内容一样，直接抄同一份 data URI。见 HOOKS.md「插件自己的图标」。
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMWYyOTM3Ii8+PHRleHQgeD0iNjQiIHk9Ijg0IiBmb250LXNpemU9IjYwIiBmb250LWZhbWlseT0ic3lzdGVtLXVpLHNhbnMtc2VyaWYiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiM2MGE1ZmEiIHRleHQtYW5jaG9yPSJtaWRkbGUiPkE8L3RleHQ+PC9zdmc+",
    maxConcurrency: 4, // 1-1000
    refreshLead: REFRESH_LEAD_MS,

    // ── provider 级开关：auth.options（可选，下面的示例取消注释就生效）─────
    //
    // magpie ≥ 0.1.2985 才认这个字段：旧版**忽略**它（开关不显示，按 `default` 走）。
    // 所以开关只能用来切换「可选行为」，不能拿它当唯一入口 —— 默认值必须是能用的。
    //
    // options: [
    //   {
    //     key: "<开关名>",                 // ⚠ 你自己的稳定键名，别跟着文案改
    //     label: "<面板上的名字>",
    //     description: "<一句话说清打开后会怎样>",
    //     default: false,
    //     placement: "top",                // ≥ 0.1.2985 才置顶；旧版忽略此字段，回退到面板底部
    //   },
    // ],
    //
    // ⚠ 切换开关**不会重跑插件工厂** —— 工厂只在插件加载时执行一次。
    //   把选项值在工厂里读成 `const on = …` 会永远停在旧值；必须在使用点实时读：
    //
    //     const on = _ctx?.magpie?.option?.(PROVIDER, "<开关名>") === true
    //
    //   `_ctx` 就是**插件工厂的第一个参数**（`export async function MeooAuthPlugin(_ctx = {}, _options = {})`），
    //   契约里写作 `input.magpie.option(provider, key)` —— 是同一个东西，**不是**某个钩子收到的入参。
    //   宿主在插件函数里能拿到 `_ctx.magpie`；测试里 `_ctx` 可能是 `{}`，必须可选链兜底（读不到 = false）。
    //   这段示例**只声明不读取**：派生仓库按自己的开关名在使用点去读，别照抄字符串。

    // ═══ ② 登录 ═══════════════════════════════════════════════════
    methods: [
      {
        type: "oauth",
        label: `${PROVIDER_NAME} 设备授权登录`,
        async authorize() {
          const flow = await startLoginFlow(http);
          return {
            url: flow.url, // magpie 打开这个地址（meoo.com/cli/login?session_id=…）
            instructions:
              "在打开的页面里登录 Meoo 并确认授权，本窗口会自动继续。" +
              "登录后若要领每日积分，再在「补充 Cookie」里粘贴网页 Cookie。",
            method: "auto",
            opened: false,

            async callback() {
              const t = await flow.result;
              if (!t) return { type: "failed", error: "登录超时或被拒绝" };

              // 自动开通项目拿项目 AK（网关凭证）。失败不挡登录：账号先落库，
              // projectAk 之后由 models/usage 的懒开通补上。
              let extra = {};
              try {
                const got = await ensureProjectAk({ apiKey: t.apiKey, userId: t.userId }, http);
                extra = { projectAk: got.projectAk, project: got.project };
              } catch {
                // 云额度满 / 初始化慢等情况：账号照常登录
              }
              return { ...accountFrom(t, extra), type: "success" };
            },
          };
        },
      },

      // Cookie 登录（推荐）：自动开浏览器让用户登录，取回的 Cookie 一步完成
      // 「身份 + 个人 AK + 签到凭据」。没有可用浏览器时报错引导粘贴方式。
      {
        type: "oauth",
        label: `${PROVIDER_NAME} 浏览器登录（自动取 Cookie，含签到）`,
        async authorize() {
          return {
            url: `${BASE}/`,
            instructions:
              "在打开的浏览器里登录 Meoo（手机号/支付宝等），登录成功后本窗口自动继续。" +
              "Cookie 会自动取回并完成全部登录；若自动开浏览器失败，改用「粘贴」方式。",
            method: "auto",
            opened: false, // chromiumLogin 自己开浏览器，magpie 不用再开

            async callback(_input, { signal } = {}) {
              const { findBrowser, chromiumLogin } = await import("./src/browser-login.mjs");
              const browser = findBrowser();
              if (!browser) {
                return { type: "failed", error: "没有找到 Chrome/Edge 等 Chromium 浏览器；请用「粘贴」方式手动给 Cookie" };
              }
              // 登录态不看 cookie 名字（埋点 cookie 打开页面就有，猜名字会误判，
              // user/me 未登录也是 200 + data:null）——直接打 user/me 验证，
              // data 非空才是真登录。每秒试一次，直到用户在窗口里完成登录。
              let lastCookie = "";
              const grabbed = await chromiumLogin({
                browser,
                url: `${BASE}/`,
                cookieNames: [], // 收所有非空 Cookie（埋点也带上，登录接口要整套）
                timeoutMs: 5 * 60_000,
                signal,
                until: async (cookies, found) => {
                  const header = Object.entries(found).map(([k, v]) => `${k}=${v}`).join("; ");
                  if (!header || header === lastCookie) return false; // 没变化就不打接口
                  lastCookie = header;
                  try {
                    const res = await fetch(`${BASE}/api/v1/user/me`, {
                      headers: { Cookie: header, Referer: `${BASE}/`, Accept: "application/json" },
                      signal: AbortSignal.timeout(8000),
                    });
                    const body = await res.json().catch(() => null);
                    return Boolean(body?.data); // data 非空 = 已登录
                  } catch {
                    return false;
                  }
                },
              });
              const cookieHeader = grabbed.cookie;
              const t = await loginByCookie(cookieHeader, http);
              // 项目 AK 一起开通（失败不挡登录）
              let extra = {};
              if (t.apiKey) {
                try {
                  const got = await ensureProjectAk({ apiKey: t.apiKey, userId: t.userId }, http);
                  extra = { projectAk: got.projectAk, project: got.project };
                } catch {}
              }
              return { ...accountFrom(t, { cookie: cookieHeader, ...extra }), type: "success" };
            },
          };
        },
      },

      // Cookie 手动粘贴（自动开浏览器失败时的兜底）
      {
        type: "oauth",
        label: `${PROVIDER_NAME} 粘贴网页 Cookie（签到 + 登录）`,
        prompts: [
          {
            type: "text",
            key: "cookie",
            message: "粘贴 meoo.com 的整段 Cookie（F12 → Network → 任意请求 → Cookie 请求头整段复制）",
            placeholder: "acw_tc=…; cdn_sec_tc=…; SESSION=…; …",
          },
        ],
        async authorize(inputs) {
          const jar = String(inputs?.cookie || "").trim();
          if (!jar) return { type: "failed", error: "没有输入 Cookie" };
          let t;
          try {
            t = await loginByCookie(jar, http);
          } catch (e) {
            return { type: "failed", error: String(e?.message ?? e) };
          }
          let extra = {};
          if (t.apiKey) {
            try {
              const got = await ensureProjectAk({ apiKey: t.apiKey, userId: t.userId }, http);
              extra = { projectAk: got.projectAk, project: got.project };
            } catch {}
          }
          return { ...accountFrom(t, { cookie: t.cookie, ...extra }), type: "success" };
        },
      },

      // 手动粘贴：个人 AK（meoo_ak_…）或带补充信息的 JSON。
      {
        type: "api",
        label: `${PROVIDER_NAME} 个人 AK / Cookie 粘贴`,
        prompts: [
          {
            type: "text",
            key: "value",
            message: "粘贴个人 AK（meoo_ak_…）或完整 JSON（含 apiKey/cookie/projectAk）",
            placeholder: "meoo_ak_… 或 {\"apiKey\":\"…\",\"cookie\":\"…\"}",
          },
        ],
        async authorize(inputs) {
          const value = String(inputs?.value || "").trim();
          if (!value) return { type: "failed", error: "没有输入任何内容" };
          // 整段 JSON：直接当快照收下。
          if (value.startsWith("{")) {
            try {
              const parsed = JSON.parse(value);
              if (typeof parsed.apiKey !== "string" || !parsed.apiKey) {
                return { type: "failed", error: "JSON 里没有 apiKey 字段" };
              }
              return accountFrom(
                { apiKey: parsed.apiKey, userId: parsed.userId || "", username: parsed.username || "" },
                { ...(parsed.cookie ? { cookie: parsed.cookie } : {}), ...(parsed.projectAk ? { projectAk: parsed.projectAk } : {}) },
              );
            } catch {
              return { type: "failed", error: "以 { 开头但不是合法 JSON" };
          }
          }
          // 裸 AK：验证一下身份再收。
          if (!/^meoo_ak_/.test(value)) {
            return { type: "failed", error: "个人 AK 应以 meoo_ak_ 开头（项目 AK 调不了身份接口）" };
          }
          let who = {};
          try {
            who = await identity(value);
          } catch (e) {
            return { type: "failed", error: `AK 验证失败: ${e?.message ?? e}` };
          }
          return accountFrom({
            apiKey: value,
            userId: String(who?.userId || who?.id || ""),
            username: String(who?.username || who?.nickname || ""),
          });
        },
      },
    ],

    // ═══ ③ 续期 ═══════════════════════════════════════════════════
    /**
     * 返回值 **合并** 到旧账号上（与 client.auth.set 的整体替换不同）。
     *
     * 运行时机：OAuth 账号的 expires 距现在 < refreshLead 时，
     * 在 loader / models / usage / 请求之前。
     *
     * 串行化：同一 refresh_token 的并发续期会合并成一次（`src/refresh-lock.mjs`），
     * 成功后 60 秒内回放结果 —— 一次性 refresh_token 不会被用两次，
     * 宿主 `auth.refresh` 与请求链路同时触发也不会各花一次旧 token。
     *
     * expires 为 0 或不存在的账号永不续期。
     */
    async refresh(auth, provider) {
      if (!auth?.refresh) return undefined // 没有 refresh_token，不续期

      try {
        // 键 = 凭据身份；同 key 的并发调用共享同一个 in-flight promise
        const t = await refreshLock.run(`${PROVIDER}\n${auth.refresh}`, () => exchangeRefresh(auth.refresh)) // TODO: exchangeRefresh 按厂商实现
        if (!t) return undefined
        return {
          access: t.access_token,
          // 服务端可能轮换 refresh_token，没给就沿用旧的
          refresh: t.refresh_token ?? auth.refresh,
          expires: Date.now() + t.expires_in * 1000,
        }
      } catch (e) {
        // refresh_token 被拒 → 标记账号，不再重试直到重新登录
        if (/invalid_grant|expired|invalid/i.test(String(e?.message))) {
          throw Object.assign(new Error("登录已失效，请重新登录"), { signIn: "expired" })
        }
        // 其它错误 → 30 秒后重试
        throw e
      }
    },

    // ═══ ④ 请求接管 ═══════════════════════════════════════════════
    /**
     * 每个账号跑一次（登录态变化后会重跑）。
     *
     * 返回的字段：
     *   baseURL  请求去哪（优先于模型的 api 和 provider 的 api）
     *   apiKey   按 npm 包自动加头：
     *              @ai-sdk/anthropic → x-api-key
     *              @ai-sdk/google    → x-goog-api-key
     *              其它              → Authorization: Bearer
     *   headers  每个请求都加
     *   fetch    真正的请求函数
     *
     * 请求头的设置顺序（后者覆盖前者）：
     *   sdkHeaders(apiKey) → loader.headers → gateway 的 → chat.headers 的
     */
    async loader(getAuth, provider) {
      const auth = await getAuth()
      if (!auth || auth.type !== "oauth") return {}

      const snap = snapshotOf(auth)
      if (!snap?.projectAk) {
        // 没有项目 AK 就没法调网关 —— 报得明确，别拿个人 AK 硬打。
        throw new Error(
          "Meoo 账号还没有项目 AK（模型网关凭证）；请用 meoo-cli 或控制台开通项目后在「粘贴」方式里补 projectAk",
        )
      }

      return {
        baseURL: `${GATEWAY}`, // api.meoo.host/meoo-ai/compatible-mode/v1
        apiKey: snap.projectAk,
        headers: {
          // Meoo 的网关按浏览器 UA 放行（meoo2api 实测结论），自产品名会被判第三方。
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        },

        async fetch(input, init) {
          // ⚠ 每次重新读 auth —— 可能已被 refresh 更新
          const fresh = await getAuth()
          if (!fresh) throw new Error(`${PROVIDER_NAME} 未登录`)
          const freshSnap = snapshotOf(fresh)
          if (!freshSnap?.projectAk) throw new Error("Meoo 项目 AK 缺失")

          const req = input instanceof Request ? input : null
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : req?.url ?? ""

          // 合并请求头：先取进来的，再被我们的覆盖
          const incoming = new Headers(init?.headers ?? req?.headers ?? {})
          const headers = {
            authorization: `Bearer ${freshSnap.projectAk}`,
            "content-type": "application/json",
          }
          for (const [k, v] of incoming) {
            const lower = k.toLowerCase()
            // 这几个必须由我们决定
            if (["authorization", "x-api-key", "x-goog-api-key", "host", "content-length", "user-agent"].includes(lower)) continue
            headers[k] = v
          }

          let body = init?.body
          if (body === undefined && req) body = await req.text()

          // TODO: 按需改写 body（meoo 网关吃标准 OpenAI chat/completions，无需改写）

          const res = await fetch(url, {
            method: init?.method ?? "POST",
            headers,
            body,
            signal: init?.signal ?? req?.signal ?? AbortSignal.timeout(300_000),
          })

          // 模型不存在 → 返回 404，magpie 只搁置这个模型
          // if (res.status === 404) { ... }

          // 登录被拒 → 401 或响应头 X-Magpie-Sign-In: expired
          // 这个 401 是别的事 → X-Magpie-Sign-In: kept
          // 已续期 → X-Magpie-Sign-In: renewed

          // 只分类 400/422 的明确余额/渠道/模型/限流错误；SSE 与其它响应原样返回。
          return rewriteRefusal(res)
        },
      }
    },

    // ═══ ⑤ 额度 ═══════════════════════════════════════════════════
    /**
     * 决定卡片上的进度条。
     *
     * windows[].name     → 进度条上方的标签
     * windows[].used     → 已用百分比（0-100，超额 >100）
     * windows[].display  → 数字显示，如 "2,131.63 / 3,400 积分"
     * windows[].amount   → 已用
     * windows[].limit    → 总量
     * windows[].unit     → 单位
     * windows[].resetsAt → 重置时间
     * windows[].aside    → true 表示用光不停账号（附加额度）
     *
     * 只给 used 不给 display/amount/limit → 只有光秃秃的进度条。
     */
    async usage(getAuth, provider) {
      const auth = await getAuth()
      if (!auth) return { error: "未登录", windows: [] }

      // 只缓存有凭据身份的账号；匿名调用本来就不会打到上游。
      const usageKey = uidOf(auth)
      if (!usageKey) return { error: "未登录", windows: [] }

      let u
      try {
        u = await usageCache.readSWR(String(usageKey), () => fetchUsage(auth, http), { timeoutMs: 10_000 })
      } catch (e) {
        // 上游失败 → 让卡片显示原因。抛出去 magpie 只会记成「读取失败」，用户看不到原因。
        return { error: String(e?.message ?? e), windows: [] }
      }

      // ⚠ 下面的窗口由 src/quota.mjs 的构造器生成 —— 它在**写法错**时直接抛 QuotaShapeError：
      //   写错的窗口不会让插件崩，只会让 GUI 显示「剩余额度未知」、让这个号在智能路由里
      //   被当成不存在，而日志里什么都没有。把这几类错变成运行时错误，是这个构造器唯一的用途。
      return buildUsage({
        plan: u.plan,       // 卡片上的 "Free plan" 标签
        user: u.user,       // 厂商那边这个账号的名字
        balance: u.balance, // "5,300 积分"

        // Meoo 的积分是钱包型余额（没有窗口上限）—— fetchUsage 已按
        // 钱包形状造好窗口，这里直接透传。
        windows: u.windows,
      })
    },

    // ═══ ⑥ 签到 ═══════════════════════════════════════════════════
    /**
     * 调用规则（magpie 契约原文）：
     *   - 按 **北京时间**，每账号每天一次
     *   - 当天失败后还会再调
     *   - 抛异常 = 失败
     *   - 在账号的 scope 里，它刷新的 token 会存到该账号
     *
     * outcome 六种：
     *   "claimed"     刚签到成功
     *   "done"        今天已经签过了
     *   "ineligible"  这个账号不能参加
     *   "inactive"    没有签到活动
     *   "captcha"     厂商要验证码 —— 让用户去官方 App 手动签，永不解
     *   "failed"      失败
     */
    async checkin(getAuth, provider) {
      const auth = await getAuth()
      if (!auth) return { outcome: "failed", message: "未登录" }

      const account = uidOf(auth)
      if (!account) return { outcome: "failed", message: "未登录" }
      const key = `${provider?.id || PROVIDER}\n${account}`
      return checkinLock.run(key, async () => {
        try {
          const r = await doCheckin(auth, http)

          // 厂商没有签到功能（Meoo：没有网页 Cookie 就是这种，说明写进 message）
          if (!r.supported) {
            return { outcome: "inactive", message: r.message || `${PROVIDER_NAME} 无每日签到` }
          }

          // 今天已经签过
          if (r.alreadyToday) {
            return { outcome: "done", message: "今天已签到", streak: r.streakDays }
          }

          // 厂商要验证码 —— 永远不要去解
          if (r.needsCaptcha) {
            return {
              outcome: "captcha",
              message: "厂商要求验证码，请到官方 App 里手动签到",
            }
          }

          // 刚签到成功
          return {
            outcome: "claimed",
            credit: r.credit,
            streak: r.streakDays,
            message: r.message,
          }
        } catch (e) {
          return { outcome: "failed", message: String(e?.message ?? e) }
        }
      })
    },
  },

  // ═══ ⑦ 每账号的模型目录 ═══════════════════════════════════════
  /**
   * magpie 为每个账号调一次，在该账号的 scope 和代理里。
   *
   * provider.models 是「上次的列表」（models.dev + config 钩子给的）。
   *
   * 失败回退的三种方式：
   *   1. fetch 失败后原样返回 provider.models
   *   2. 抛异常
   *   3. 返回自己的列表并设 list[Symbol.for("magpie.fellBack")] = true
   *
   * ⚠ 局部成功时**不要**标 fellBack —— 那样 magpie 会整份丢弃。
   *
   * 登录态失效 → 抛带 signIn: "expired" 的错误。
   */
  provider: {
    id: PROVIDER,

    async models(provider, { auth } = {}) {
      const fallback = staticModels()
      if (!auth || auth.type !== "oauth") return fallback

      try {
        const live = await fetchLiveModels(auth, http, _ctx?.client ?? null)
        if (!live.length) return fallback

        const out = {}
        for (const m of live) {
          // 保留静态表里的配置，只更新 id/name/limit
          const base = fallback[m.id] ?? Object.values(fallback)[0]
          out[m.id] = { ...base, id: m.id, name: m.name ?? m.id }
        }
        return out
      } catch (e) {
        // 登录被拒 → 标记账号
        if (/401|unauthorized|expired/i.test(String(e?.message))) {
          throw Object.assign(new Error("登录已失效"), { signIn: "expired" })
        }
        return fallback
      }
    },
  },

  // ═══ ⑧ 每请求加头 ═════════════════════════════════════════════
  /**
   * input.sessionID 是 magpie 的会话 id，同一会话多轮不变。
   * 可以用来做服务端的 session / cache 头。
   */
  "chat.headers": async (input, output) => {
    const id = input?.model?.providerID ?? input?.provider?.info?.id
    if (id !== PROVIDER || !input?.sessionID) return
    output.headers["x-meoo-session"] = String(input.sessionID).slice(0, 128)
  },
  }
}

// ── Meoo 具体实现 ────────────────────────────────────────────────────
//
// 凭据形状（auth.access 存 JSON 字符串）：
//   { apiKey, userId, username, projectAk?, cookie? }
//   · apiKey     个人 AK（设备授权签发），身份与积分查询用
//   · cookie     网页 Cookie（可选补充）：只有它才能领「每日登录积分」；
//                设备授权拿不到它 —— 有就签到，没有就明确说不可用
//   · projectAk  项目 AK（调模型）；设备授权流程里尝试自动开通，失败可后补
// 账号身份：userId 优先，退到 apiKey 指纹（uidOf 已按 access 全文哈希）。

import { MeooError, dailyLogin, deviceSessionCreate, deviceSessionPoll, ensureProjectAk, expired, identity, loginByCookie, loginPageUrl, modelCatalog, points } from "./src/meoo.mjs"

// access 字段是 JSON 文本 → 解析；坏了返回 null（调用方报 needsLogin）。
function snapshotOf(auth) {
  const raw = typeof auth?.access === "string" ? auth.access.trim() : "";
  if (!raw.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.apiKey === "string" && parsed.apiKey ? parsed : null;
  } catch {
    return null;
  }
}

// ── 登录：设备授权（官方 CLI 的同一套）───────────────────────────────

async function startLoginFlow(http = fetch) {
  const sessionId = await deviceSessionCreate(http);
  const flow = { sessionId, url: loginPageUrl(sessionId), result: null, wake: null };
  flow.result = new Promise((resolve) => {
    flow.wake = resolve;
  });
  // 轮询放后台：callback() 会 await flow.result，magpie 面板等用户在浏览器确认。
  (async () => {
    const deadline = Date.now() + 10 * 60_000;
    try {
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const state = await deviceSessionPoll(flow.sessionId, http);
        if (state.status === "approved") {
          flow.wake(state);
          return;
        }
        if (state.status === "expired" || state.status === "denied") {
          flow.wake(null);
          return;
        }
      }
      flow.wake(null); // 超时
    } catch {
      flow.wake(null);
    }
  })();
  return flow;
}

// access 快照 → magpie 账号字段的公共部分。
function accountFrom(state, extra = {}) {
  const snapshot = {
    apiKey: state.apiKey,
    userId: state.userId || "",
    username: state.username || "",
    ...extra,
  };
  return {
    type: "success",
    refresh: "",
    // 个人 AK 未见官方有效期说明；真正的判据是上游 401（signIn: expired）。
    expires: 0,
    access: JSON.stringify(snapshot),
    accountId: state.username || state.userId || "Meoo",
    uid: state.userId || "",
    ...Object.fromEntries(
      Object.entries(extra).flatMap(([k, v]) =>
        k === "cookie" || k === "projectAk" ? [] : [[k, v]],
      ),
    ),
  };
}

// ── 续期：无 refresh_token，什么都不做 ───────────────────────────────

async function exchangeRefresh() {
  // Meoo 的个人 AK 不轮换（meoo2api 同样不做续期）；失效靠 401 → signIn 标记。
  throw new MeooError("Meoo 个人 AK 不支持刷新；失效后请重新授权", { status: 400 });
}

// ── 额度：积分余额（个人 AK）─────────────────────────────────────────

async function fetchUsage(auth, http = fetch) {
  const snap = snapshotOf(auth);
  if (!snap) throw expired();
  const [available, who] = await Promise.all([
    points(snap.apiKey, http),
    identity(snap.apiKey, { cookie: snap.cookie }, http).catch(() => ({})),
  ]);
  const name = String(who?.username || who?.nickname || snap.username || snap.userId || "Meoo");
  return {
    plan: "Meoo",
    user: name,
    // 积分是钱包型余额（没有窗口上限）；拿不到就留空让卡片显示未知。
    ...(available != null
      ? { balance: `${available} 积分` }
      : {}),
    windows: [
      available != null
        ? usageWindow({ name: "积分", balance: available, unit: "积分" })
        : usageWindow({ name: "积分", used: 0, display: "余额未知" }),
    ],
  };
}

// ── 签到：每日登录积分（网页 Cookie）────────────────────────────────

async function doCheckin(auth, http = fetch) {
  const snap = snapshotOf(auth);
  if (!snap) throw expired();
  try {
    const r = await dailyLogin(snap, http);
    if (r.unsupported) {
      return {
        supported: false,
        message: "该账号没有补充网页 Cookie —— 设备授权拿不到它，暂不能领每日积分",
      };
    }
    if (r.already) {
      return { supported: true, alreadyToday: true, ...(r.balanceAfter != null ? { balance: r.balanceAfter } : {}) };
    }
    if (r.granted) {
      return { supported: true, granted: true, credit: r.amount ?? 0, ...(r.balanceAfter != null ? { balance: r.balanceAfter } : {}) };
    }
    // 上游既没发也没说已领 —— 按未开放处理，不硬凑成功。
    return { supported: true, granted: false, message: "上游未发放今日积分（也没有已领标记）" };
  } catch (e) {
    if (e instanceof MeooError && e.signIn) throw e;
    throw e;
  }
}

// ── 模型目录（项目 AK；没有就用静态表）──────────────────────────────

async function fetchLiveModels(auth, http = fetch, client = null) {
  const snap = snapshotOf(auth);
  if (!snap) return []; // 未登录/快照坏：静态表兜底
  let projectAk = snap.projectAk;
  // 懒开通：登录时没拿到项目 AK 的，这里补一次并回写到账号（auth.set 合并保存）。
  if (!projectAk && client?.auth?.set) {
    try {
      const got = await ensureProjectAk(snap, http);
      projectAk = got.projectAk;
      await client.auth.set({
        path: { id: PROVIDER },
        body: { ...auth, access: mergeIntoSnapshot(auth, { projectAk, project: got.project }) },
      });
    } catch {
      return []; // 开通失败不算错，静态表兜底
    }
  }
  if (!projectAk) return [];
  const live = await modelCatalog(projectAk, http);
  return live;
}

// Cookie / 项目 AK 的后补入口：登录后从面板粘贴整段 Cookie 或项目 AK。
function mergeIntoSnapshot(auth, patch) {
  const snap = snapshotOf(auth) ?? {};
  const merged = { ...snap, ...patch };
  return JSON.stringify(merged);
}

// 供测试引用（⚠ 入口文件不要导出 helper 函数，否则会被当插件调用）
export const _internal = {
  PROVIDER,
  PROVIDER_NAME,
  BASE,
  GATEWAY,
  staticModels,
  MODELS,
  snapshotOf,
  accountFrom,
  mergeIntoSnapshot,
}
