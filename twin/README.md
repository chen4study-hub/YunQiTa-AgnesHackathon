# 云栖塔 · 能源数字孪生集成说明

React + TypeScript + Vite 看板，包含总览、预测与风险、Agent 决策、楼层与电梯、能源与告警和关于六页。桌面按可用视口网格排布，矮窗口允许内容区滚动；手机纵向阅读，固定底栏由 main 动态留白。组件展示页为 `/showcase.html`。

## 启动与构建

需要 Node ≥22.12（建议当前 Node LTS）与 npm，在仓库根目录执行：

```powershell
cd twin
npm ci
npm run dev
```

打开 <http://127.0.0.1:5173>。生产构建与本地预览：

```powershell
npm run build
npx vite preview --host 127.0.0.1
```

构建会检查类型、生成许可全文，输出至 `dist/`。关于页 dev/build 都显示 Git 短哈希；没有 Git 或没有 `.git` 的源码包仍可启动/构建，显示“源码包”，`dist/build-info.json` 的 revision 为 null。

### 预压缩与部署

构建使用锁定版本的 `vite-plugin-compression2@2.5.3`，为 JS、CSS、JSON（含 `public/replay` 数据）、HTML 和 SVG 同时生成 `.br` 与 `.gz`，保留原文件；小文件也生成两种副本。完整上传 `dist/`，不要只上传原文件或删除压缩副本。`vite preview` 的小中间件直接发送预压缩字节，不在请求时压缩：根据 `Accept-Encoding` 的质量值选择格式，同等质量优先 Brotli，其次 gzip，未支持则发送原文件。响应包含原文件 MIME 类型、`Content-Encoding` 与 `Vary: Accept-Encoding`；HEAD 和缓存验证不发送实体。

生产环境应由静态服务器/CDN 直接协商压缩副本，客户端仍请求 `/replay/normal.json` 或 `/assets/*.js`，**不要**把业务 URL 改为 `.br`/`.gz`。nginx 示例（放在 server 配置中，先包含标准 `mime.types`）：

```nginx
root /srv/yunqi/dist;
include /etc/nginx/mime.types;
default_type application/octet-stream;

# 需要 nginx --with-http_gzip_static_module；仅发送已有 .gz。
gzip_static on;
gzip_vary on;
# 可选：安装并加载 ngx_brotli 后启用；支持 br 时优先发送 .br。
# brotli_static on;

location / {
    try_files $uri $uri/ /index.html;
    add_header Vary Accept-Encoding always;
}
```

没有 Brotli 模块时保留注释即可用 gzip；启用 Brotli 后检查实际 `Content-Encoding: br`。缓存/CDN 必须区分 `Accept-Encoding`，不能将压缩字节再二次压缩，也不能把 `.br` 按二进制 MIME 发送。`/api` 反向代理配置仍独立维护，Vite preview 不是生产服务器。

```powershell
# 先构建，再验证产物、preview 响应头及首屏 logo 请求次数。
npx playwright test e2e/precompressed-preview.spec.ts
curl.exe -I -H "Accept-Encoding: br, gzip" http://127.0.0.1:4173/replay/normal.json
```

favicon 由 HTML 转换钩子以内联形式复用生成的品牌 SVG；顶栏和关于页使用同一静态 URL，首屏不再额外请求同文件作为 favicon。

本机 PATH 无 Node 时：`powershell -File ./start.ps1 -Task build`（使用已有 Codex Node 与 twin/.tools 下 npm）。

访问 http://127.0.0.1:5173。Playwright 使用本机 Edge，无需下载 Chromium。
产物在 `dist/`（Git 忽略）。临时自检截图放仓库外；`docs/screenshots/` 不是本轮临时输出目录。

- `src/components/`：独立 UI 组件与 ECharts / TwinScene 包装。
- `src/core/`：保留的纯 TypeScript Three.js 核心。
- `reference/screens/`：8 张截图与 8 张细节图，原样保留。

## 三种数据源与后端

- 文件（默认）：<http://127.0.0.1:5173/?source=file>，读取 `public/replay/index.json`、`normal|peak|abstain.json` 和 `model_card.json`。
- 确定性样例：<http://127.0.0.1:5173/?source=mock>，不依赖后端，用于交互检查，非真实计量。
- API：<http://127.0.0.1:5173/?source=api>，同源 `/api/replay`、`/api/replay/{scenario}`。Vite dev 和 preview 将 `/api` 转发到 `http://127.0.0.1:8000`，去掉 `/api` 前缀；例如 `/api/replay/normal` → 后端 `/replay/normal`。代理配置在 `vite.config.ts`。

后端在仓库根目录、已安装 `requirements.txt` 的 Python 环境启动：

```powershell
python -m uvicorn src.api.app:app --host 127.0.0.1 --port 8000
```

健康检查 <http://127.0.0.1:8000/health>，接口文档 <http://127.0.0.1:8000/docs>。可改查询为 `?source=api&api=http://localhost:8000` 直接跨域访问，后端需要允许 CORS。API 模型卡仍从本地 `/replay/model_card.json` 读取。Agent 页的 `/api/health`、`/api/schedule` 查询独立于看板文件源；后端不在线时使用文件数据兜底，不能据此声称在线调度已验收。

数据读取失败会退回确定性 mock，遇到数值不符先查 Network 是否读取成功。正式更新文件源，在仓库已具备导出文件时执行 `npm run sync-replay`。部署 `dist/` 到普通静态服务器时 **没有 Vite 代理**，必须由部署服务器配置 `/api` 反向代理，或使用直连 API URL 和 CORS。

`sync-replay` 只读根 exports/replay、exports/model_card.json、contracts/replay.schema.json，复制到 twin；构建不依赖根目录。前端展示日期不改回放原始日期。

状态可订阅，包含页面、典型日、小时、选中楼层及所有开关；切页不重置。运行徽章为指定产品文案，不代表真实设备已连接。

## 验证与许可证

```powershell
npm run licenses
npm run build
npm test
$env:PLAYWRIGHT_PORT='5187'
npm run test:e2e
```

`npm run licenses` 核验当前平台已安装的运行/构建依赖及许可证全文，将同一内容同步至仓库根 `THIRD_PARTY_NOTICES` 和 `public/THIRD-PARTY-LICENSES.txt`；构建后 `dist/THIRD-PARTY-LICENSES.txt` 应与二者逐字节一致。包括 BDG2 数据声明与前端依赖全文，不替代 Python 依赖审计。源码包独立构建只生成 public/dist 文件，不依赖父目录。

`npm test` 用 Vitest。新增 `license-notices.test.ts` 需要先 build，核对根/public/dist 与直接依赖完整性。Playwright 使用本机 Edge；每次独占端口，`PLAYWRIGHT_PORT` 可换成空闲值。生产提交号测试需要最新 `dist/`，提交后先重新 build；无 Git 构建测试在系统临时目录创建无 `.git` 副本并自动清理（依赖复用本地 node_modules）。

推荐单项复核：

```powershell
npx playwright test e2e/build-revision.spec.ts e2e/scene-paused.spec.ts
npx playwright test e2e/site-language.spec.ts e2e/site-consistency.spec.ts
```

