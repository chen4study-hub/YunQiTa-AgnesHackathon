# Byron地点与节假日实际使用审计

## 数据身份与地点

实际使用Building Data Genome 2（BDG2），主楼ID **Hog_office_Byron**，不是名为“Byron”的独立数据集。BDG2官方README说明数据为2016–2017两年小时表计，并包含ASHRAE Great Energy Predictor III竞赛子集。

本地原始metadata.csv：site_id=Hog，Kaggle building_id=1148/site_id=13，Office，timezone=US/Central，lat=44.9787818478/lng=-93.2553976421。这一坐标指向美国明尼苏达州明尼阿波利斯区域；不能据它断言匿名楼的真实机构、街道地址或休业制度。Byron是数据楼标识，不是Byron城镇的证据。现有America/Chicago显示时区与US/Central一致。

来源：https://raw.githubusercontent.com/buds-lab/building-data-genome-project-2/master/README.md

## 节假日规则

美国OPM解释：联邦雇员的周末节日通常在相邻周五/周一观察。采用USFederalHolidayCalendar历史2016/2017观察日代理，并以原始墙钟日期生成holiday。不得把已贴UTC标签的原始墙钟再次转Chicago，造成跨日错误。楼宇实际关闭日、明州地方制度及学校假期尚未确认；不擅自加入。

来源：https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/

## 实际使用审计与修复

审计前：
- 特征构建器含holiday列，但champion `paper-inspired-v1` 的日期列表为空，holiday始终0。
- 现有静态GET回放 `byron2017-v1-cqr` 日期列表也为空，未启用。
- 上轮扩充历史研究包已启用日期列表，模型含holiday列，但此前未接入POST判断。

本轮：新增显式楼栋影子路由 `configs/prediction_routes.json`，Byron的POST `/predict`、调用同预测路径的`/schedule`与`/explain`使用来源哈希绑定的扩充历史+节假日CQR包；版本 **byron-expanded-holiday-shadow-v1**。包训练/校准结束前的请求拒绝，2016/2017之外年份拒绝（不让有限历史日期列表伪装实时节假日日历）。输入仍需BUILDING_DATA_CSV的目标前一小时完整历史。原API响应格式不变，其他楼仍走全局champion，champion本身不升级。

测试用2017-10-09联邦观察日，验证目标行holiday=1、POST返回对应版本、schedule仍shadow；从历史中删去目标与未来负荷。先用9月4日测试被校准时间保护正确拒绝，随后改用校准后10月9日。

**GET回放仍是旧静态版本，不含节假日模型，未悄悄覆盖。**前端若只看GET，它看到的不是本轮模型。旧模型与新POST路由并存必须按model_version区别，不宣称回放已更新。新路径仍只是历史影子预测，节假日覆盖率不足/样本少的问题没有消失，禁止自动设备控制。
