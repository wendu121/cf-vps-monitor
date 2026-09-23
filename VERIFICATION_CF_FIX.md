# VERIFICATION_CF_FIX — 自审（门禁 ②）

**变更范围**：1 个文件，1 处根因 + 2 处留痕
**文件**：`worker/src/utils/cf-client.ts`（`getProjectCustomDomains()`）
**日期**：2026-09-23

---

## 一、问题（boss 报告）

`/admin/cf`「域名与 SSL」表不齐全：CF 上有 **10** 条自定义域名（worker 6 + pages 4），面板只有 **6** 条。

## 二、根因（已实证）

`worker/src/utils/cf-client.ts:244`（改前）：

```ts
const j = await this.cfFetch(`/accounts/${this.accountId}/pages/projects?per_page=100`);
```

**CF 的 Pages list 接口不接受任何分页参数**。实测：

```
GET /client/v4/accounts/{acc}/pages/projects?per_page=100
→ HTTP 400  {"code":8000024,"message":"Invalid list options provided.
             Review the `page` or `per_page` parameter."}

GET /client/v4/accounts/{acc}/pages/projects
→ HTTP 200  {"success":true,"result":[…4 个项目…]}
```

该 400 被同一函数的 `catch { /* 权限不足或接口异常则忽略 */ }` **静默吞掉**，导致
`out.pages` 永远为空 → `syncCfAssets()` 只落 worker 的 6 行。

**同文件自相矛盾（佐证这是疏漏而非有意）**：`listPages()`（L199-200）写对了，还留有注释
「Pages list 不支持 per_page（带则 400），故不传分页参数拉全量」。

`grep -n "pages/projects" worker/src` → 3 命中：L200（对）、L244（**错**）、L248（逐项目域名，正确）。

## 三、改动

| # | 位置 | 改动 |
|---|---|---|
| 1 | `cf-client.ts:248` | 删除 `?per_page=100`（**根因**） |
| 2 | `cf-client.ts:264-266` | 外层 catch 由静默改为 `console.warn`（留痕） |
| 3 | `cf-client.ts:259-261` | 逐项目 domains 的 catch 同样留痕 |

改动 2/3 的理由：本次事故的传播机制就是「静默吞错 → 整块缺失无人察觉」，不堵住这个机制，
同类 bug 会再次无声发生。

**未改动**：`workers/domains?per_page=100`（L230）—— 实测该接口接受 `per_page` 并返回 **200**，
非同类问题，不动。

## 四、门禁 ① 校验

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `tsc --noEmit -p worker/tsconfig.json`（worker/node_modules 的 typescript） | **EXIT=0**，零输出（无类型错误） |
| 落盘复核 | `grep -n "pages/projects\|per_page" worker/src/utils/cf-client.ts` | L248 已无 `per_page`；L261/L266 已有 warn；见下 |

落盘实证（改后 grep 输出，节选）：

```
244:      // ⚠️ Pages list 不支持任何分页参数：带 `per_page` 会返回 HTTP 400
248:      const j = await this.cfFetch(`/accounts/${this.accountId}/pages/projects`);
261:          console.warn(`[cf] pages domains for "${p.name}" failed: ${…}`);
266:      console.warn(`[cf] pages projects list failed: ${…}`);
```

> 注：`npm run build` 里的 `wrangler types --check` 仍会因 `worker-configuration.d.ts`
> 环境指纹不符而失败（**既有问题，与本次改动无关**，见 2026-09-23 项目日志）。
> 故校验走 `tsc --noEmit` 单跑 + 部署走 `node scripts/deploy-cloudflare.mjs`。

## 五、可观察结果验证（只读，未写任何数据）

脚本 `_verify_cf_fix.mjs` 用与 `syncCfAssets()` **完全相同**的 CF API 调用序列，算出修复后
`cf_domains` 应有多少行：

```
[A] 旧写法 /pages/projects?per_page=100 → HTTP 400  code=8000024   → pages 域名 = 0 条
[B] 新写法 /pages/projects              → HTTP 200  项目数=4
[C] sspro     /domains → v.wemdy3.indevs.in(active)
    katelyatv /domains → hv.zhanghuan.ggff.net(pending)
    hellotv   /domains → v.huanhuan.de5.net(active)
    zh001tv   /domains → zhangmengting.dpdns.org(pending)
[D] worker /workers/domains?per_page=100 → HTTP 200  6 条（未改动，对照）
[E] 预期行数 = 6 + 4 = 10   （修复前实测 = 6，净增 4）
```

`pages/projects` 的列表接口 `domains` 字段只给了 2 条 Pages 自定义域名，
**逐项目 `/domains` 才是完整真值（4 条）** —— 该接口在修复后才能被真正执行到。

## 六、未闭环项（如实声明，不假装完成）

1. **尚未部署**：本变更未上线，线上面板仍是旧行为（6 条）。
2. **线上端到端未验**：部署后需 `POST /api/admin/cf/sync` 再查 `/api/admin/cf/domains`，
   预期返回 **10** 条且含 `project_type='pages'` 的 4 行。此项在部署前无法完成。
3. **`ssl_days_left` 对新增 4 行的取值未经线上核对**：依赖 `matchZoneId()` +
   `getZoneSslInfo()`；其中 2 个域名状态为 `pending`（CF 侧 DNS 未生效），
   SSL 可能回落 `未知`/CT log 估算 —— **属预期行为，但需部署后肉眼确认不误导**。

## 七、已知但本次不修（超出 boss 报告范围）

`listZones()`（L150-155）有三重过滤 `status==='active' && !paused && account.id===本账号`：
实测当前 12 个 zone 全部满足，**本次未过滤掉任何一个**；但将来出现 paused/非 active 的 zone
会**静默消失**。属设计取舍（注释称「即 CF 上部署的真实站点」），需 boss 决定是否改为「显示但标注状态」。
