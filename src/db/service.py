"""Public takeover service; export reads happen before short write transactions."""
import json
from datetime import datetime
from .connection import ROOT, Database
from .evidence import ExportEvidence, finite, public_text
from .repository import Repository, Conflict, controls
from .time import hour_ms, HOUR_MS, ZONE


class TakeoverService:
    def __init__(self, repository=None, evidence=None):
        self.repository = repository or Repository()
        self.evidence = evidence or ExportEvidence()

    def recommendation(self, date, hour):
        return self.evidence.recommendation(date, hour)

    def validate(self, payload):
        power = controls(payload['hvac_setpoint_c'], payload['storage_mode'], payload['storage_power_kw'])
        start = hour_ms(payload['date'],payload['hour'])
        duration = payload['duration_hours']
        if isinstance(duration,bool) or not isinstance(duration,int) or not 1<=duration<=24:
            raise ValueError('时长应为 1–24 小时')
        public_text(payload['reason'])
        public_text(payload['operator_id'])
        recommendation = self.recommendation(payload['date'],payload['hour'])
        supplied = payload.get('recommendation_hash')
        if supplied is not None and supplied != recommendation['recommendation_hash']:
            raise Conflict('推荐已更新，请重新确认')
        limits = json.loads((ROOT/'configs/agent_tools.json').read_bytes())['equipment']
        if not max(24,limits['min_temp_c'])<=payload['hvac_setpoint_c']<=min(27,limits['max_temp_c']):
            raise ValueError('设定温度超出设备允许范围')
        if abs(power)>min(500,limits['battery_max_kw']):
            raise ValueError('功率超出设备允许范围')
        # Coverage is checked for every display hour, including next-day source mappings.
        for at in range(start,start+duration*HOUR_MS,HOUR_MS):
            when=datetime.fromtimestamp(at/1000,ZONE)
            row, provenance=self.evidence.hour(when.date().isoformat(),when.hour)
            if provenance['building_id']!=recommendation['building_id']:
                raise ValueError('时段楼宇不一致')
            if at==start:
                soc=row.get('storage',{}).get('soc')
                if power and (not finite(soc) or not limits['min_soc']<=soc<=limits['max_soc']):
                    raise ValueError('储能电量依据暂不可用')
            if power:
                soc-=power/limits['battery_capacity_kwh']
                if not limits['min_soc']-1e-9<=soc<=limits['max_soc']+1e-9:
                    raise ValueError('该功率和时长会超出储能电量范围')
        return recommendation

    def create(self, payload):
        return self.repository.create(payload,self.validate(payload))

    def update(self, identifier, payload, expected_version):
        return self.repository.update(identifier,payload,self.validate(payload),expected_version)

    def receipt(self,date,hour,operator):
        records=self.repository.receipts(date,hour)
        if records:
            response=dict(source=records[-1]['source'],records=records,
                          receipt=dict(count=len(records),elapsed_ms=0.0,transport='log_only',device_connected=False),
                          active_takeover=self.repository.get_active(date,hour))
        else:
            response=self.evidence.receipt(date,hour)
        self.repository.record_receipt_view(operator,date,hour,response)
        return response
