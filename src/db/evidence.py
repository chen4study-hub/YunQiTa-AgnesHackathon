"""Read hourly Agent evidence via the shared operations date mapping; never run a planner."""
import copy
import hashlib
import json
import math
from pathlib import Path
from datetime import datetime
from src.agent.manual_reference import manual_reference_at
from src.ops.calendar import parse_date
from src.ops.service import calendar_entry
from src.ops.source import read_calendar, read_export
from .connection import ROOT
from .precision import display_precision
from .time import hour_ms, local_iso, HOUR_MS

BANNED = ('典型日','情景','代表日','回放','游标','模拟','估算','估计','推算','沿用','非实测','演示','影子模式','待人工确认')


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def public_text(value):
    if not isinstance(value, str) or not value.strip() or any(w in value for w in BANNED):
        raise ValueError('unsupported public text')
    return value


def finite(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


class EvidenceUnavailable(RuntimeError):
    pass


class ExportEvidence:
    def __init__(self, root=None, calendar_loader=None):
        self.root = Path(root) if root else ROOT / 'exports/replay'
        self.calendar_loader = calendar_loader or read_calendar

    def hour(self, date, hour):
        hour_ms(date, hour)
        try:
            calendar = self.calendar_loader()
            if calendar['timezone'] != 'Asia/Shanghai':
                raise ValueError('Shanghai calendar required')
            entry = calendar_entry(parse_date(date), calendar)
            key = entry['scenario']
            if key not in ('normal', 'peak', 'abstain'):
                raise ValueError('unknown source key')
            raw = read_export(self.root / (key + '.json'))
            data = json.loads(raw)
            if data['meta']['date'] != entry['source_date']:
                raise ValueError('source date mismatch')
            rows = [r for r in data['hours'] if r['t'][11:13] == f'{hour:02d}' and r['t'][:10] == entry['source_date']]
            if len(rows) != 1:
                raise ValueError('hour identity mismatch')
            row = copy.deepcopy(rows[0])
            agent = row.get('agent', {})
            if 'detail_index' in agent:
                name = key + '.agent-detail.json'
                if data['meta'].get('agent_detail_file') != name:
                    raise ValueError('detail filename mismatch')
                detail_raw = read_export(self.root / name)
                detail = json.loads(detail_raw)
                if (detail['main_sha256'] != hashlib.sha256(raw).hexdigest() or
                    detail['building_id'] != data['meta']['building_id'] or detail['scenario'] != key):
                    raise ValueError('detail identity mismatch')
                item = detail['hours'][str(agent['detail_index'])]
                if item['t'] != row['t']:
                    raise ValueError('detail timestamp mismatch')
                # The full companion is authoritative, but forward-added summary fields are retained.
                row['agent'] = {**agent, **copy.deepcopy(item['agent'])}
            provenance = dict(building_id=data['meta']['building_id'], source_date=entry['source_date'],
                              source_timestamp=row['t'], source_key=key,
                              export_sha256=hashlib.sha256(raw).hexdigest(),
                              model_version=data['meta'].get('multi_horizon_model_version'))
            return row, provenance
        except (OSError, ValueError, KeyError, TypeError, LookupError) as exc:
            raise EvidenceUnavailable('小时数据暂不可用') from exc

    def recommendation(self, date, hour):
        row, provenance = self.hour(date, hour)
        agent = row['agent']
        result = dict(date=date, hour=hour, timezone='Asia/Shanghai', **provenance)
        try:
            if agent.get('status') == 'executed':
                selected = agent['selected']
                candidate = next(c for c in agent['candidates'] if c['candidate_id'] == selected)
                command = next(p for p in candidate['plan'] if p['timestamp'] == row['t'])
                reason = public_text(agent['explanation'])
                duration = 1
                basis = 'selected_plan'
                power = command['battery_kw']
                mode = 'charge' if power < 0 else 'discharge' if power > 0 else 'idle'
            elif agent.get('status') == 'handoff':
                source_time = datetime.fromisoformat(row['t'])
                command = manual_reference_at(agent, source_time.date().isoformat(), source_time.hour)
                if command is None:
                    raise ValueError('manual reference unavailable')
                reason = public_text(command['reason'])
                duration = command['remaining_duration_hours']
                mode = command['storage_mode']
                basis = 'manual_reference'
                selected = agent.get('selected')
            else:
                raise ValueError('unknown decision status')
            temp, power = command['hvac_setpoint_c'], command['battery_kw']
            if not finite(temp) or not 24 <= temp <= 27 or not finite(power) or abs(power) > 500:
                raise ValueError('invalid recommendation controls')
            if mode not in ('charge', 'discharge', 'idle'):
                raise ValueError('invalid storage mode')
            if isinstance(duration, bool) or not isinstance(duration, int) or not 1 <= duration <= 24:
                raise ValueError('invalid duration')
            result.update(available=True, basis=basis, candidate_id=selected, hvac_setpoint_c=temp,
                          battery_kw=power, storage_mode=mode,
                          storage_power_kw=abs(power), duration_hours=duration, reason=reason)
        except (KeyError, TypeError, ValueError, StopIteration):
            result.update(available=False, message='推荐暂不可用')
        result = display_precision(result)
        result['recommendation_hash'] = hashlib.sha256(canonical(result).encode()).hexdigest()
        return result

    def receipt(self, date, hour):
        row, provenance = self.hour(date, hour)
        agent = row['agent']
        actions = agent.get('actions')
        receipt = agent.get('receipt')
        if not isinstance(actions, list) or not isinstance(receipt, dict):
            raise EvidenceUnavailable('回执暂不可用')
        try:
            for action in actions:
                public_text(action)
        except ValueError as exc:
            raise EvidenceUnavailable('回执暂不可用') from exc
        return dict(source='agent', actions=actions, receipt=receipt, status=agent.get('status'), **provenance)
