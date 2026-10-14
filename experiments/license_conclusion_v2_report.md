# 许可证结论统一及临时审计工具

统一对外结论：**未使用 GPL/AGPL 许可的依赖；部分科学计算运行库带 GCC 运行库例外**。

结论限定于已审计依赖元数据及本项目选择的许可方案，不作发布物全部文件的法律保证。NumPy/SciPy的GPL-3.0-or-later WITH GCC-exception-3.1、FreeType的FTL OR GPL选择（本项目采用FTL）、Pillow上游构建/源文件许可证说明、MPL注意事项都继续保留，不修改原始许可证全文。根THIRD_PARTY_NOTICES保留Python/数据说明；嵌入前端全文只经同步脚本读取权威文件，逐字节测试通过。

## 工具隔离实跑

`python -m scripts.audit_dependency_licenses` 已改为TemporaryDirectory内新建venv，只在该venv安装固定pip-licenses==5.5.5，通过`--python`审计项目解释器，而非临时工具依赖。新v2摘要/清单/原文单独保存，不覆盖历史v1。退出删除临时目录，成功与安装失败清理均有离线单元测试。安装子进程不继承LLM/API key、私有pip/代理配置；不打印安装输出/原始异常。

本轮实跑：54个Python包、121个前端锁条目，顶层GPL/AGPL标记和UNKNOWN均为0；三份清单内容哈希与先前一致。全局包清单前后完全相同，临时venv已删除。用户先前卸载全局审计工具，本轮未重新安装到全局。pip-licenses官方`--python`实现参考：https://raw.githubusercontent.com/raimon49/pip-licenses/master/piplicenses.py 。

## 收尾

完整后端pytest181通过，1个既有Starlette/httpx warning；包括模板来源枚举、72小时分类、前端通知逐字节同步、临时venv成功/失败清理。常驻服务未接管，仍需重启以加载代码。

并行前端代理已经提交`6f4e8a7`注册1.4（只读确认）；本代理没有修改twin/或替前端跑验收。第1项给前端字段说明见docs/replay_contract14.md；原旧版本白名单仍不能直接接受1.4。新增checkpoint加入gitignore，删除自有临时提交清单，凭据原字节扫描和暂存秘密检查后提交。
