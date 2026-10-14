# 跨建筑迁移状态

已实现 `python -m src.transfer data/observations.csv --target-building B_ID`：源建筑训练点预测及尺度模型，在目标建筑时间靠前的本地窗口只调整风险百分位、拒绝阈值与共形乘数；在后续目标窗口计算 MAE、RMSE、CV(RMSE)、NMBE、PICP、PINAW、拒绝率及保留误差。单测 `tests/test_transfer.py` 的随机生成数据仅证明流程可运行，不是现实建筑迁移证据。2026-10-09 已使用真实 BDG2 六栋子集：留出 Robin_education_Billi，源为另五栋，目标本地校准 1,757 行；最终测试全样本 PICP 93.47%、MAE 3.616；拒绝率 63.28%，保留 PICP 85.54%、MAE 4.059。留出建筑历史单步回测，不代表独立站点或长期线上迁移；见 `experiments/bdg2_6building.md`。
