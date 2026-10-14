# 预编译 schema 校验器

运行 `npm run generate:validators` 生成 standalone 浏览器 ESM；`npm run check:validators` 检查漂移。`npm run build` 和 `npm run dev` 会先生成。生成文件已提交，直接启动 Vite 也可使用；修改 schema 后应先生成。

```ts
import {
  validateOps, validateOpsCalendar, validateReplay, validateAgentDetail,
  validationErrorsText,
} from "./validators";

validateOps(input);                  // boolean；完整 ops day/calendar/floors 联合 schema
validateOpsCalendar(input);          // boolean；只接受日历
const check = validateReplay("1.5");  // 返回校验函数，支持 1.2 / 1.3 / 1.4 / 1.5
check(input);                        // boolean
validateAgentDetail(input);          // boolean；Agent 明细 schema
if (!check(input)) console.error(validationErrorsText(check.errors));
```

各校验函数的 `.errors` 与 Ajv 相同，仅对应最近一次调用；成功后为 `null`。未知 replay 版本返回始终拒绝的校验函数。不会改写输入，不会抛出契约异常；调用者决定异常或降级方式。

**仅做 schema 校验**。小时排序、窗口关系、SHA、主/明细身份与小时索引等业务检查必须保留在调用者。A 的 `data/validate.ts` 与 `pages/agent/record-history.ts` 尚未切换，本次不改。

生成源沿用各消费者当前路径与配置：
- ops：仓库根 `contracts/ops.schema.json`，`allErrors`、`multipleOfPrecision: 8`。
- 日历：`src/data/contracts/ops.schema.json` 的 `oneOf[1]`，与 record-history 一致。
- replay / agent-detail：`src/data/contracts/`，`allErrors`、`strictNumbers`、`strictTypes: false`。

源文件可能不一致，生成器不会擅自同步 A 的 schema。每份产物头部记载源路径和 SHA-256。

`ops loader` 单独导入 `validators/ops` 和 `validators/types`，避免聚合入口带入其余校验器。standalone 所需格式/helper 已在生成阶段打包，运行时不导入 Ajv 编译器。全站在 A 切换前仍可能含 Ajv；仅 ops 链路已移除。
