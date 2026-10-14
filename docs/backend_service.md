# 本地后端服务与自动重启

服务：`python -m uvicorn src.api.app:app --host 127.0.0.1 --port 8000 --no-access-log`，由`scripts.serve_backend`托管。读取现有.env与其指向的key文件；脚本不改环境变量或配置、不打印key/请求体，不用Windows计划任务。仅监听本机，未开放网络端口。

## 普通PowerShell中启动/停止

在项目根目录运行：

```powershell
python -m scripts.serve_backend start
python -m scripts.serve_backend status
Invoke-RestMethod http://127.0.0.1:8000/health
```

`start`创建独立进程组并请求脱离父进程job，返回PID并非证明已ready；必须看status及health。占用8000/已有锁时拒绝接管，不杀其他服务。普通终端若系统仍拒绝独立启动，可在单独PowerShell窗口运行：

```powershell
python -m scripts.serve_backend run
```

保留该终端。Child退出后每次递增5秒、上限30秒重启，宿主独占锁防重复运行。自动重启覆盖uvicorn子进程挂掉；不覆盖守护进程自身被系统杀掉或电脑重启，不装自启动。状态文件日志均在logs/且gitignored。

停止（在项目根目录另一个终端）：

```powershell
python -m scripts.serve_backend stop
python -m scripts.serve_backend status
```

stop请求文件由守护进程处理，终止自有child、保存stopped状态并退出。不要用已失效PID误杀不相关进程；status只是最近状态，health才是存活核验。配置修改后stop/start重启，不自动reload.env。

## 日志

- logs/backend_uvicorn.log：子进程启动/错误日志，不记access/request正文。
- logs/backend_supervisor.log：child PID、退出码、重启次数、停止事件。
- logs/backend_launcher.log：启动器输出。
- logs/backend_supervisor.json：最新PID/状态，含child_pid/restarts。
- logs/backend_probe.json：本地探测的安全状态元数据，不保存原始LLM响应。

日志追加写入；长时间运行应在服务停止后归档，不在运行中改文件。未实现操作系统级服务/守护进程失效恢复。

## 本轮验证与阻塞（2026-10-11）

当前工具的短期Windows job在调用结束后回收Start-Process父子进程。独立启动CREATE_BREAKAWAY_FROM_JOB返回PermissionError/WinError5拒绝访问；没有绕过限制、没有计划任务、未改配置。**当前并未保持常驻**。

`python -m scripts.probe_backend --managed`在同一次受控调用中验证：

1. /health.status=ok、model_ready=True、llm.mode=real；
2. 只结束自有uvicorn child后守护进程成功重启、新PID、restarts=1；
3. POST/chat真实峰值问答known=True、grounded=True、llm_mode=real、answer_source=llm_tools、selected_tool=forecast_peak、call_succeeded；
4. 测试完成主动stop，state=stopped。不能把一次调用内的成功说成常驻成功。

如在已有持续运行服务上只做检查：`python -m scripts.probe_backend`。这会发一次真实chat请求，不要用于无网络离线检查。用--managed则会先确认没有服务，再启动/故障重启验证并结束自有服务。前端会话通过现有代理接127.0.0.1:8000；本会话不改twin配置。
