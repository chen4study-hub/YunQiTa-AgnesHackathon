# 第3项：许可证与离线演示收尾

## 许可证实际审计

历史v1实跑记录保留；当前结论与临时venv审计见 dependency_license_audit_v2.json，前端文本按权威文件逐字节同步。本段描述先前实跑，不代表当前仍安装全局审计工具。

执行 `python -m scripts.audit_dependency_licenses`（pip-licenses 5.5.5），保存元数据、随包完整许可证文本、SHA256与只读前端锁清单。54个已安装Python包、121个前端锁条目均无顶层GPL/AGPL标签、无UNKNOWN许可证。

统一结论：未使用 GPL/AGPL 许可的依赖；部分科学计算运行库带 GCC 运行库例外。运行库明细：NumPy/SciPy随包GCC运行库明确有GPL-3.0-or-later WITH GCC-exception-3.1；FreeType有FTL OR GPL双许可（选择FTL）；Pillow随包说明还包含XZ脚本/构建源文件GPL/LGPL提及，未逐个核验发布文件。没有识别到独立AGPL组件。以上范围和例外已写入THIRD_PARTY_NOTICES，并保留其既有数据/前端通知。保留例外明细；再分发前需检查具体发布物和例外条件，不是法律保证。

## 离线演示

`python -m scripts.check_offline_demo` 实跑通过。临时复制src/configs/exports，不复制.env/secrets，移除继承的LLM/OPENAI/ANTHROPIC等配置；明确demo并禁用dotenv加载。独立回环端口启动真实uvicorn后端，在导入业务代码前阻止外部DNS/socket.connect/connect_ex；外部尝试计数为0。此为Python应用级隔离，不声称操作系统防火墙。仅管理自身创建的进程，finally停止并清理临时目录，不接管8000常驻后端。

依次访问 `/health`、`/replay`、`/replay/peak`、`/schedule`、`/chat`、`/chat/stream`，全部HTTP200。schedule真实demo模式、回执2条、未连接设备；chat真实demo模式且grounded；SSE完整step/tool_start/tool_end/answer_delta/done，无error。

模式证据需区分：health/schedule/chat原响应均为demo；replay是历史静态数据，没有运行时llm_mode，不能篡改其中历史real标签冒充demo；SSE done契约亦无llm_mode。后两类的runtime_llm_mode来自同一隔离进程health，不宣称每个接口都原生带该字段。静态历史标签不意味着离线检查调用了真实LLM。不增加公共字段，不改契约。

全套pytest172通过，1个既有Starlette/httpx弃用warning。新增测试再启动独立后端验证HTTP/SSE、环境去凭据、许可证摘要SHA与例外。凭据精确字节和暂存秘密扫描后，仅提交本项自有文件。常驻scripts.serve_backend仍需用户重启以加载前两项代码。
