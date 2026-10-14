# BDG2 候选榜（2026-10-09）

| 模型 | pilot CV(RMSE) | pilot retained PICP | test CV(RMSE) | test retained PICP | 状态 |
|---|---:|---:|---:|---:|---|
| paper-inspired-v1 | 13.798% | 93.21% | 16.605% | **89.46%** | pilot 达晋级条件；测试与迁移覆盖不足，影子模式 |

## 本轮2017候选（不同数据人口，不能与旧冠军直接比较）

| 模型/profile | pilot retained PICP | test retained PICP | test retained MAE | test拒绝率 | 状态 |
|---|---:|---:|---:|---:|---|
| Hog85栋 global v1 | 91.65% | 91.95% | 3.871 | 32.98% | 子组Byron几乎全部拒绝，非champion |
| Byron单楼 static rho30 | 94.51% | 81.13% | 8.683 | 43.53% | 不足覆盖，非champion |
| Byron单楼 CQR rho15 | 91.69% | **87.68%** | 9.197 | 19.71% | 回放专用，不达标、非champion |

源：`experiments/bdg2_6building.md`、`byron_validation_search.csv`、`byron_operating_points.csv`、`models/registry.json`。35个固定验证组合（5个rho×7个方法）已在 Windows 任务计划 `AgnesHackathon_ByronSearch` 完成，日志 `logs/byron_search.log`；退出0。只在pilot上选择profile，最终测试不用于选择，候选间纯区间变化不满足同拒绝率MAE改进的冠军条件。旧champion仍paper-inspired-v1，全部仅影子模式。

后续点模型队列见 `candidate_queue.json`：XGBoost/CatBoost/N-HiTS/PatchTST/Chronos/TimesFM/NREL BuildingsBench。树模型screen已由后台任务 `AgnesHackathon_PointSearch` 完成退出0（XGBoost3.4.1、CatBoost1.2.10依赖装项目`.experiment-deps`，任务现已禁用防重复）。验证同预算风险排序保留**744/876小时**：LightGBM MAE9.601/PICP93.28%、XGBoost **8.856/92.07%**、CatBoost9.523/91.40%；各自真正校准固定门控拒绝率3.88%/3.08%/9.93%不同，因此排序诊断不作为自动晋级证据。XGBoost值得下一轮预注册验证，但**未读测试标签计算成绩、未晋级/重新导出**。详 `point_validation_screen.csv`。深模型仍为blocked_dependency，未下载权重或运行；全量1,104栋仍未复现。
