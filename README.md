# 秒悟 Meoo — magpie 插件

Meoo（秒悟）官方模型网关的 magpie / OpenCode 供应商插件：设备授权登录、积分余额、**每日登录积分（签到）**与 OpenAI 兼容反代。

## 功能

- 🔑 **设备授权登录**：走官方 CLI 的同一套通道（`meoo.com/cli/login`），浏览器确认授权即完成，不建 OAuth 应用。
- 📊 **积分余额（auth.usage）**：`GET /open/v1/cli-compat/account/points`，钱包型余额（积分无窗口上限）。
- 🎁 **每日登录积分（auth.checkin）**：`GET /api/mc/entitlement/init`，官方网页侧的每日积分。
- 🧠 **模型目录（provider.models）**：有项目 AK 时实时拉 `api.meoo.host` 网关目录；否则用内置兜底表。
- ⚡ **OpenAI 兼容反代（auth.loader）**：项目 AK 直连 `api.meoo.host/meoo-ai/compatible-mode/v1`。

## 登录方式

1. **浏览器登录（推荐）**：自动打开受控 Chromium 窗口，你在页面里正常登录 Meoo，Cookie 自动取回 —— 一步完成「身份 + 个人 AK + 项目 AK + 签到凭据」，之后无需任何粘贴。
2. **粘贴网页 Cookie**：F12 复制 meoo.com 的整段 Cookie 粘进来，效果同上（自动开浏览器失败时的兜底）。
3. **设备授权**：官方 CLI 的 `meoo.com/cli/login` 通道；注意这条通道**拿不到网页 Cookie**，签不了到，需要签到请用方式 1/2。
4. **粘贴个人 AK**：只有 `meoo_ak_…` 时用；不能签到，项目 AK 需另行补充。

## 模型与费率（官方 pricing.md，每 1k tokens 扣积分）

### API 网关实际可调（`/models` 实时白名单，2026-11-15 实测）

| 模型 | 输入 | 输出 | 缓存命中 | 上下文 | 实测延迟* | 备注 |
|---|---|---|---|---|---|---|
| Qwen3.8-Flash（默认） | 0.8 | 2.7 | 0.1 | 1M | 5.3s | 工具调用 ✅；思考 token 计输出费 |
| Qwen3.7-Plus（限时八折） | 1.6 | 6.4 | 0.16 | 262K | 1.7s | 性价比好 |
| DeepSeek V4.1 Flash | 2 | 8 | 0.2 | 1M | 1.2s | 实测最快 |
| DeepSeek V4 Flash | 3 | 9 | 0.3 | 1M | 2.5s | |
| Qwen3.7-Max（限时五折） | 6 | 18 | 0.6 | 262K | 1.5s | |
| DeepSeek V4 Pro | 9 | 27 | 0.9 | 1M | 2.4s | 最大输出 384K |
| Qwen3.8-Max | 12 | 36 | 1 | 1M | 2.1s | |
| GLM-5.2-Fast-Preview | 16 | 56 | 4 | 1M | 4.0s | 最贵档 |
| GLM-5.2 | 8 | 28 | 2 | 1M | 4.4s | |

\* 延迟为「回答一个字」小请求实测，仅供参考。

**计费规则（两轮 13 次请求实测，误差 0）**：每条请求按 tokens × 费率计算后**逐条向上取整到整数积分**；思考 token（`reasoning_tokens`）计入输出费。

**2026-11-20 白名单变更实测**：`qwen4-max-preview` 改名为 `qwen4-max`；**Kimi K3 / K3.1-Pro 系被移出**（请求回 `MODEL_NOT_SUPPORTED`）。

### 费率表里有、但 API 调不了的（勿选）

| 模型 | 状态 |
|---|---|
| Qwen4-Max-Preview | ❌ **403 Access denied** —— 在目录里但当前账号档位无权调用（实测） |
| GLM-5.3-Flash / GLM-5.3 | ❌ **MODEL_NOT_SUPPORTED** —— 仅网页版可用，API 网关白名单没有（上游明确返回"当前仅支持配置模型: …"） |
| Kimi K3.1 Pro / Kimi-K3 / MiniMax M3.1 Flash | 未进 API 白名单（同上，仅网页版） |

插件会以 `/models` 实时目录为准；上游放开新模型时自动跟上。

## 签到的重要说明

「每日登录积分」（2000 积分/天）是**网页侧**权益，认**网页 Cookie**：

- 用**浏览器登录 / 粘贴 Cookie** 方式登录的账号：Cookie 已在快照里，签到直接可用。
- 只用**设备授权**的账号：明确报「无网页 Cookie，暂不能领每日积分」——**不假装成功**；补一次 Cookie 即可。
- Cookie 失效（401 / 重定向登录页）→ magpie 标记需重新登录；项目 AK 不受影响，模型照常可调。

## 三种凭证的关系（来自 meoo2api 的一手实测）

| 凭证 | 用途 | 来源 |
|---|---|---|
| 个人 AK（`meoo_ak_…`） | 身份、积分查询 | 设备授权签发 |
| 项目 AK（`meoo_project_…`） | **调模型**（进反代） | 控制台 / meoo-cli 开通项目 |
| 网页 Cookie | **每日积分（签到）** | 浏览器手动复制 |

## 安装

```bash
magpie plugin add /path/to/magpie-meoo   # 本地目录
# 或发布后：
magpie plugin add meoo-auth
```

## 测试与自检

```bash
npm test              # 403 条单测（协议层 + 插件接入，网络全打桩）
node scripts/check.mjs  # scaffold 自检 45 项
```

## 参考来源

- [LazyBonesLZY/meoo2api](https://github.com/LazyBonesLZY/meoo2api)（MIT）：设备授权、积分端点、每日积分响应形状与「Cookie 需手动补」的结论均来自它的 Go 实现（`internal/checkin/checkin.go`、`internal/account/*.go`）的一手实测。
- [ali-meoo/meoo-cli](https://github.com/ali-meoo/meoo-cli)（MIT）：设备授权流程的官方参照。
- 模板的完整开发文档在 [docs/TEMPLATE-README.md](./docs/TEMPLATE-README.md)（scaffold 原版 README）。

## License

MIT
