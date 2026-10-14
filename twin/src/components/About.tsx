import { version } from '../../package.json';
import { Card } from './Card';
import { useDashboard } from '../state/context';
import './about.css';
import { buildMetadata } from '../config/buildMetadata';
import {formatNumber as n} from '../ui/numberFormat';
import {formatLocalMinute} from '../config/displayTime';

const layers = [
  ['数据', '数据接入：BDG2 公开数据集；小时计量与天气共用契约。'],
  ['预测', '未来 24 小时负荷与区间；天气不读取未来实测。'],
  ['门控', '风险与置信度门控；拒绝时保留原因并转人工。'],
  ['执行', '约束检查后记录日志回执；当前部署未接入现场设备。'],
  ['看板', '三维、预测与能源共用时间轴；数值连续，决策离散。'],
] as const;
const correspondences = [
  ['总负荷与气温', '来自 BDG2 Byron 楼 2017 年逐时实测，按日期类型对应到今天。'],
  ['24 小时预测与区间', '由模型输出，只用起报前的数据。'],
  ['楼层负荷', '将整栋负荷按 40 层用途和固定密度系数分摊。'],
  ['储能、光伏与电网购入', '按设备参数和规划结果计算。'],
  ['空调分区温度', '用线性热模型做舒适检查。'],
  ['BA/EMS 下发', '走日志接口，换成现场适配器就能接真实设备。'],
] as const;
export function About() {
  const {state} = useDashboard();
  const card = state.modelCard;
  const percent = (v:unknown) => typeof v==='number' ? `${n(v*100)}%` : '未测量';
  const power = (v:unknown) => typeof v==='number' ? `${n(v)} kW` : '未测量';
  const metrics = [
    ['保留样本覆盖率', percent(card?.retained_coverage)], ['区间标称覆盖率', '90%'],
    ['拒绝率',percent(card?.rejection_rate)], ['保留样本 MAE',power(card?.retained_mae)],
    ['全样本 MAE',power(card?.all_sample_mae)],
  ];
  const revision = buildMetadata.revision;
  const coverageBars = [
    {label:'保留样本覆盖率', value:card?.retained_coverage},
    {label:'区间标称覆盖率', value:0.9},
    {label:'拒绝率', value:card?.rejection_rate},
  ];
  return <section className="about-page about-dense" aria-label="关于云栖塔">
    <Card className="about-intro" label="项目简介"><div className="about-card-body">
      <img className="yunqi-logo about-logo" src={`${import.meta.env.BASE_URL}brand/yunqi-tower.svg`} alt="云栖塔项目 logo" />
      <h1>一栋塔楼，一个能源决策闭环</h1>
      <ul className="about-selling"><li>未来 24 小时：点预测与区间同时呈现</li><li>40 层扭转塔：按当天分位数显示负荷</li><li>低置信度转人工：决策、理由与回执可追溯</li></ul>
      <dl className="about-build"><div><dt>版本号</dt><dd>v{version}</dd></div><div><dt>提交号</dt><dd className="about-revision">{revision}</dd></div><div><dt>构建时间</dt><dd className="about-build-time">{formatLocalMinute(buildMetadata.time)}</dd></div><div className="about-source"><dt>源码仓库</dt><dd><a href="https://github.com/chen4study-hub/YunQiTa-AgnesHackathon" target="_blank" rel="noopener noreferrer">GitHub · YunQiTa-AgnesHackathon</a></dd></div></dl>
    </div></Card>
    <Card className="about-architecture" label="技术架构"><div className="about-card-body">
      <h2>技术架构</h2><ol className="architecture-flow" aria-label="数据到预测、门控、执行与看板的流程">{layers.map(([name])=><li key={name}>{name}</li>)}</ol>
      <dl className="architecture-details">{layers.map(([name,description],i)=><div key={name}><dt><em>{String(i+1).padStart(2,'0')}</em>{name}层</dt><dd>{description}</dd></div>)}</dl>
      <div className="about-boundary"><b>运行边界</b><p>楼层负荷按总量分配，非分层电表读数；能源流为计算字段。补间不改变整点门控。候选方案的费用只比较可自动调度的时段，转人工时段不计入。</p></div>
      <div className="about-access"><h3>数据接入</h3><div className="about-access-notes"><p>人工接管和指令记录写入后端数据库，当前部署未接入现场设备。</p><p>运维问答由服务端调用模型和工具回答，服务不可用时用已核验的工具结果回答。</p><p>超出楼宇数据范围的问题，会通过公开的百科和搜索服务查询，问题原文会发送给这些服务。</p></div></div>
    </div></Card>
    <Card className="about-model" label="模型与数据"><div className="about-card-body">
      <h2>模型与数据</h2><p className="model-version">负荷预测 v1 · 按楼每日校准</p>
      <p>预测可靠性按本楼前 10 天的误差每日更新，只用当天之前的数据。全年保留覆盖率由 90.4% 升至 90.7%，拒绝率由 16.2% 降至 15.8%。数据突变时仍需转人工；对低风险楼宇启用后，拒绝可能增多。</p>
      <div className="about-metrics">{metrics.map(([label,value])=><div key={label}><span>{label}</span><b>{value}</b></div>)}</div>
      <figure className="about-rate-chart" aria-label="模型卡比例指标，统一零到百分之百刻度"><figcaption>比例指标 · 0–100%</figcaption>{coverageBars.map(({label,value})=><div className="about-rate-row" key={label}><div><span>{label}</span><b>{label === '区间标称覆盖率' ? '90%' : percent(value)}</b></div><div className="about-rate-track"><i style={{width:typeof value==='number' ? `${Math.max(0,Math.min(1,value))*100}%` : '0%'}} /></div></div>)}<small>模型卡评估；比例不可相加。</small></figure>
      <dl className="about-data-scale"><div><dt>数据集 / 站点</dt><dd>BDG2 / Hog</dd></div><div><dt>主楼面积</dt><dd>80,038 m²</dd></div><div><dt>参数化楼层</dt><dd>40 层 · 按面积参数化</dd></div><div><dt>接入规模</dt><dd>{state.data?.hours.length ?? 24} 小时 · {state.data?.campus.length ?? '—'} 栋园区</dd></div></dl>
    </div></Card>
    <Card className="about-collaboration" label="开发与协作"><div className="about-card-body">
      <h2>开发与协作</h2><div className="agh-credit"><img className="agh-logo" src={`${import.meta.env.BASE_URL}brand/agnes-harness-mark-cyan.png`} alt="Agnes Harness 标志" /><b>由 Agnes Harness（AGH）协助开发</b></div>
      <dl className="about-work"><div><dt>实现</dt><dd>三维场景、公共控件与数据展示的协作开发。</dd></div><div><dt>验证</dt><dd>类型检查、单测与浏览器测试；检验边界、连续性和页面溢出。</dd></div><div><dt>可复现</dt><dd>保留生成脚本与小时数据；图表更新不重建实例。</dd></div><div><dt>人工确认</dt><dd>视觉、交互与信息边界由使用者验收；不确定结论保留提示。</dd></div></dl>
      <p>云栖塔是项目主品牌，AGH 标志仅用于协作署名。</p>
    </div></Card>
    <Card className="about-license" label="许可与署名"><div className="about-card-body">
      <h2>许可与署名</h2><p><b>Building Data Genome 2（BDG2）</b></p>
      <a href="https://doi.org/10.1038/s41597-020-00712-x" target="_blank" rel="noreferrer">Miller et al., 2020 · Scientific Data 7, 368</a>
      <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">CC BY-SA 4.0</a>
      <p>使用经筛选、清洗的小时数据；预测输出、楼层分配及能源计算字段为后续加工，非原始设备实测。</p>
      <a className="license-link" href={`${import.meta.env.BASE_URL}THIRD-PARTY-LICENSES.txt`} target="_blank" rel="noreferrer">第三方许可</a>
      <p>依赖许可证全文随构建产物提供，此处不逐项列出。</p>
    </div></Card>
    <Card className="about-correspondence" label="虚实对应"><div className="about-card-body">
      <h2>虚实对应</h2>
      <dl className="about-correspondence-list">{correspondences.map(([name,description])=><div key={name}><dt>{name}</dt><dd>{description}</dd></div>)}</dl>
    </div></Card>
  </section>;
}
