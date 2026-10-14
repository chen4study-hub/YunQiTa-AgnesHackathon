/** Selection and wording are distinct provenance fields. Visible badge only names selection. */
export interface DecisionProvenance {selectionSource?:string;explanationSource?:string;}
export function decisionSourceLabel(d:DecisionProvenance){
 return d.selectionSource==='llm'?'LLM 决策':d.selectionSource==='rule'||d.selectionSource==='mock'?'规则决策':'决策来源未提供';
}
export function decisionSourceTitle(d:DecisionProvenance){
 return d.explanationSource==='template'?'模板措辞':d.explanationSource==='llm'?'LLM 措辞':'措辞来源未提供';
}
