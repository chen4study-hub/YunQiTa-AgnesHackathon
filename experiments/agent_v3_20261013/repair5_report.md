# repair5：评分/多轮追问/预取后首轮10秒收尾

**需要重启。CHAT_AGENT_LOOP代码默认仍关，线上配置由部署控制。本次是相关题验收，不是91题全量或全面通过。**

## 修改范围

- 评分只核对问题明确指定电梯，逐id绑定该句读数；不因工具额外返回运行中电梯无floor而误拒L1楼层。没有指定对象仍查全部，错电梯/错值负例拒绝。
- exclusion_present连续范围继承同句最近今天/次日标签，例如“次日08:00–09:00、13:00–19:00”后半也属次日；不跨句继承，不用另一句原因作支持。修复共享函数，供两边验证及补答使用。
- probe.evaluate接受真实最终pipeline trace作为查工具证据，而不是只依赖tool_start；没事件但实际building_state读数可过，完全没查工具仍拒。没有伪造工具事件。
- 业主/物业缺记录评分共用no_local_identity，覆盖“记录里没有公开信息”“信息这边没有相关记录，查不到”等，不强制单一句式；夹带身份断言的负例拒绝。
- agent_followup从服务端可信context_id工具记录投影SOC单读数、室外湿度、光伏功率、峰值时间、比较排除时间/原因。只在同building/scenario/origin/date/clock/session缓存key匹配才直接答，不采用assistant数字。这些模板explanation_source=template、llm_called=false，不计模型自己答。时钟/本楼身份缺记录狭窄问题直接模板。history有空调设定语境时，“比刚才的设定调低一度”加空调意图，用真实当前设定比较，不拿assistant假温度作为基准。
- 只有要求“刚才时间再说一遍”才不重复预测置信提示；只追问“比较排除了哪些时段”不用又重复不按整天/电费，但全部排除时钟和原因仍保留。正式比较仍按原要求核验。去掉模型开头“修正：”修订语。
- 预取已经是查工具：首轮after_tool=bool(records)，有预取时整个模型请求最多10秒（首响应仍10秒），不再允许首响应后拖到25秒。无工具通用聊天仍原总预算，不是所有首轮都10秒。已有可信工具参考答不额外重试是cb542f2；即时tool_end是ebbf7dd，此次不重复修改该时序。
- HVAC fallback识别真实trace compare_costs对应hvac_compare，避免此前过滤所需工具时把比较丢掉；“现在是什么天气”特定本楼问法不当概念或城市名，以本楼weather预取。

未改app.py、导出、规划器、ops/db、takeover.py、general_chat.py、chat_router.py、web_search.py、twin及其它会话文件。工程相关测试，不造Qx建模批准或全量评审。

## 离线、冻结与运行

prepare_repair5.py生成原round4相关索引17/21/37/75/80/84/85/90＋热修电价/累计充电，共10题；原round4十组20问原字节复制，问题不改。旧round4误拒收据6条作离线fixture，另2类on/off原始trace结构正反例，8项通过，network_calls=0，异常0；旧分数/收据均不改，不把重评分fixture算新验收。

112相关单测通过16.29秒后冻结78文件，repair5_freeze.json SHA256 `7cdc0ba0eee91554204e7c26e3a2b417ddf6fdba406d3e6ceb8fae055bcd877a`。顺序on10题2批、on20轮5批、off10题2批、off20轮5批，共14批；每批≤5题，组内两问同批，每批4轮；独立端口/tempDB，同时间仅一个本人前台probe后端。各批完成后关闭并CIM核验，无驻留、无nohup。四收据complete=true、owned_backend_stopped/background_classifiers_stopped=true，60轮pipeline捕获完整、评分异常0，空答/>25秒均0。全部完成后哈希差异为空，在本会话已有工具证据；未重跑任何已确认题。

用户后来插入紧急搜索修复，dc6ed8f在这60轮结束后另行提交，现相对历史manifest仅agent_relevance.py不同。**不改旧manifest、不把搜索修复后代码称repair5原冻结验收，也不重跑刷分。** 本批提交包含当时测试的多轮/评分代码，部署树会叠加独立搜索修复。收尾当前树116相关单测通过16.37秒，warning1为Starlette/httpx弃用，不是另一次在线验收。

## 指标与人工扣分

时间为端到端秒，P90 nearest-rank。上游超时只计被观测模型正文/决策请求（不计独立分类和公开HTTP源），取消导致旧provider无status时使用host phase；同一调用不重复累计。model_self排除host_supplemented及旧composite确定性楼宇拼接，括号model_text包括混合。模板不是模型自己答。

|范围|自动|扣分后|模型自己答（含混合）|模板|中位|P90|最慢|超时次数|
|---|---:|---:|---:|---:|---:|---:|---:|---:|
|on相关10题|8/10|7/10|8（8）|2|6.789|12.250|16.547|1|
|off相关10题|10/10|9/10|1（3）|7|3.016|12.046|12.094|2|
|on多轮20|20/20|18/20|7（7）|13|3.321|9.781|16.000|1|
|off多轮20|14/20|13/20|9（11）|9|2.335|11.735|13.781|0|

十组**两问均过**：on自动10/10、人工扣分后8/10；off自动6/10、扣分后6/10（knowledge组本来已因第2问false，扣第1问不再另减组）。两问都模型自己答：on2组、off3组；不等于正确组数。on人工剩余失败组injection、comfort；off失败weather、hvac、knowledge、comfort。最慢on10題index4为原#80调低一度；off10题同index4；on多轮index4改24度；off多轮index18当前设定。

超时逐项见repair5_summary.json：on单题index5（原#84）首响应7.485秒、完整模型请求10秒到期，用真实比较模板；on多轮index0 SOC首响应10秒到期，用可信SOC模板。off单题index4/index6旧正文12秒首响应期限；off多轮观测0。合计on2次/off2次，不能声称无上游超时或完全修复服务延迟。多轮on模板/直接答13轮，不再频繁模型调用，但分类仍可让无LLM追问到9秒：例如排除时段9.547秒、日期9.781秒、峰值时间8.218秒，非工具/正文超时。无重复首token重试放大这些已有结果请求。

人工读完60答及相关trace，按原round4 R1–R6只扣自动true、不升级false，非独立盲评。repair5_manual_review.json引用原句：on单题人数3869未分组/人单位扣1；off充电累计后多附SOC扣1；on多轮注入题仅给裸10249.4以及相对改温度末尾又附今日累计扣2；off碳中和定义重复扣1。逐组结果和收据哈希由summarize_repair5.py写repair5_summary.json，统计来自保存结果，不再调用上游、不重评分自动结论。

原始收据results/repair5_full_on.json、repair5_full_off.json、repair5_multi_on.json、repair5_multi_off.json，原round4保留。

## 剩余缺陷与结论

四类评分误拒已在离线正反例及本次样本证明：L1即使额外全梯记录也通过；off原#84/#85次日合并范围通过；off总负荷没tool_start但有真实trace通过；两边业主缺记录同义通过。没有用空reference或模型答案制造数字支持。

on相关题index4（原#80）漏改前/改后温度、index6（原#85）漏峰值改前/改后，自动false合理；当前production验证器没有全面执行这些必需项，可能mode=llm却内容不全，未中途改模型或评分。on人数3869没有“人”导致共享人数格式规则未匹配，人工扣分。injection组虽然拒绝假数却只回答真实裸数字，自动excludes通过不证明完整澄清，已扣。comfort组继承意图后确实查compare_costs，但又预取energy_totals并拼接累计费用，仍有范围污染，已扣。

off多轮weather问“现在是什么天气”误当城市问法，湿度追问误查楼宇室内40%而非室外57%；HVAC首问缺不按整天，排除追问误答现在14:00；knowledge追问没有继承碳中和概念；comfort追问误查累计费用/当前设定/回执，并未完成比较。相关单题off10/10自动不等于所有多轮改善。此次不动另一会话general_chat/chat_router等文件，明确剩余旧路由缺陷。

与round4多轮人工on5/10组相比本次8/10，仍不达全过；off仍6/10。on正文请求超时观测1/10＋1/20，不能与先前91题次数直接比降幅，也不能归因上游稳定性改变。固定先on后off、非随机盲测，上游负载随时间变，模板数和分类等待不同，不作全面性能优劣断言。服务端context进程内1800秒/key严格匹配，重启或换worker可能没有历史缓存，本次未测多worker分布式继承；纯history相对温度意图不等于读取任意过往设定。

**本批相关验收和报告已完整，不宣布v3全面通过，不改默认开关。** 用户可部署本批多轮/评分/10秒限制；需要重启。后续实际缺陷与更广的回归留新请求处理，不覆盖本轮收据或在冻结后悄悄补分。
