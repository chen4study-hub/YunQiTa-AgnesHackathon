import {it,expect} from 'vitest';
import {decisionSourceLabel,decisionSourceTitle} from '../src/config/decisionSource';
import {decisionSourceLabel as agentLabel,decisionSourceTitle as agentTitle} from '../src/pages/agent/data';
it('overview and Agent share selection-only labels with wording in hover title',()=>{
 expect(agentLabel).toBe(decisionSourceLabel);expect(agentTitle).toBe(decisionSourceTitle);
 for(const selectionSource of ['llm','rule','mock'])for(const explanationSource of ['template','llm',undefined]){const d={selectionSource,explanationSource};expect(decisionSourceLabel(d)).toBe(selectionSource==='llm'?'LLM 决策':'规则决策');expect(decisionSourceLabel(d)).not.toMatch(/措辞|模板/);expect(decisionSourceTitle(d)).toBe(explanationSource==='template'?'模板措辞':explanationSource==='llm'?'LLM 措辞':'措辞来源未提供');}
});
