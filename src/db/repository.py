"""Transactional takeover repository and immutable dispatch/audit history."""
import json
import math
import uuid
from .connection import Database, iso_time, utc_now
from .evidence import canonical, public_text, finite, ROOT
from .time import hour_ms, local_iso, day_bounds, HOUR_MS


class Conflict(ValueError):
    pass


class Missing(LookupError):
    pass


def controls(temp, mode, power):
    if not finite(temp) or not 24 <= temp <= 27:
        raise ValueError('设定温度应在 24–27 °C 之间')
    if mode not in ('charge', 'discharge', 'idle') or not finite(power) or not 0 <= power <= 500:
        raise ValueError('储能模式或功率无效')
    if (mode == 'idle' and power != 0) or (mode != 'idle' and power <= 0):
        raise ValueError('待机功率应为零，充放电功率应大于零')
    return -power if mode == 'charge' else power


def decode(row):
    if row is None:
        return None
    result = dict(row)
    result['recommendation_snapshot'] = json.loads(result.pop('recommendation_snapshot_json'))
    result['start_at'] = local_iso(result['start_ms'])
    result['end_at'] = local_iso(result['end_ms'])
    result['battery_kw'] = -result['storage_power_kw'] if result['storage_mode'] == 'charge' else result['storage_power_kw']
    return result


class Repository:
    def __init__(self, database=None, clock=None):
        self.db = database or Database()
        self.clock = clock or utc_now

    def audit(self, connection, operator, action, entity, before=None, after=None, request_id=None, *, entity_type=None):
        if entity_type is None:
            entity_type = 'takeover' if action != 'view_receipt' else 'receipt'
        cursor = connection.execute('INSERT INTO audit_log(occurred_at,operator_id,action,entity_type,entity_id,before_json,after_json,request_id) VALUES (?,?,?,?,?,?,?,?)',
                                    (iso_time(self.clock()), operator, action, entity_type, entity,
                                     canonical(before) if before is not None else None,
                                     canonical(after) if after is not None else None, request_id))
        return cursor.lastrowid

    def record_chat_event(self, session_id, question, classification, reason, *, operator_id='system', request_id=None):
        """Persist a caller-classified termination; preserve the original question verbatim."""
        for value in (session_id, question, classification, reason, operator_id):
            if not isinstance(value, str) or not value.strip():
                raise ValueError('chat audit fields must be nonempty strings')
        event = dict(occurred_at=iso_time(self.clock()), session_id=session_id, question=question,
                     classification=classification, reason=reason)
        with self.db.transaction() as connection:
            return self.audit(connection, operator_id, 'chat_terminated', session_id,
                              after=event, request_id=request_id, entity_type='chat')

    def expire(self, connection):
        now = self.clock()
        for row in connection.execute("SELECT * FROM takeovers WHERE status='active' AND end_ms<=?", (int(now.timestamp()*1000),)).fetchall():
            before = decode(row)
            connection.execute("UPDATE takeovers SET status='expired',updated_at=? WHERE id=?", (iso_time(now), row['id']))
            self.audit(connection, 'system', 'expire', row['id'], before, {**before, 'status': 'expired'})

    def overlap(self, connection, building, start, end, exclude=None):
        # Cancelled records remain audit history but no longer occupy any decision slot.
        row = connection.execute('SELECT id FROM takeovers WHERE building_id=? AND id!=? AND cancelled_ms IS NULL AND status!=\'cancelled\' AND start_ms<? AND end_ms>? LIMIT 1',
                                 (building, exclude or '', end, start)).fetchone()
        if row:
            raise Conflict('该时段已有人工接管，请先撤销或调整时段')

    def dispatch(self, connection, takeover, at_ms):
        batch = f"{takeover['id']}:{takeover['version']}:{at_ms}"
        receipt = dict(count=1, elapsed_ms=0.0, transport='log_only', device_connected=False)
        commands = [('BA', {'setpoint_c': takeover['hvac_setpoint_c']}), ('EMS', {'battery_kw': takeover['battery_kw']})]
        for destination, command in commands:
            connection.execute('INSERT INTO dispatch_log VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                               (str(uuid.uuid4()), batch, takeover['building_id'], at_ms, destination, 'manual', takeover['id'],
                                takeover['version'], canonical(command), canonical(receipt), 'recorded', iso_time(self.clock()), batch+':'+destination))

    def create(self, payload, snapshot):
        start = hour_ms(payload['date'], payload['hour'])
        end = start + payload['duration_hours'] * HOUR_MS
        building = snapshot['building_id']
        with self.db.transaction() as connection:
            request_id = payload.get('request_id')
            if request_id:
                old = connection.execute('SELECT * FROM takeovers WHERE request_id=?', (request_id,)).fetchone()
                if old:
                    old = decode(old)
                    same = (old['start_ms'] == start and old['end_ms'] == end and
                            all(old[k] == payload[k] for k in ('operator_id','hvac_setpoint_c','storage_mode','storage_power_kw','reason')))
                    if not same:
                        raise Conflict('请求编号已用于另一项配置')
                    return old
            self.expire(connection)
            self.overlap(connection, building, start, end)
            now = self.clock()
            status = 'expired' if end <= int(now.timestamp()*1000) else 'active'
            identifier = str(uuid.uuid4())
            connection.execute('INSERT INTO takeovers(id,building_id,start_ms,end_ms,timezone,operator_id,hvac_setpoint_c,storage_mode,storage_power_kw,reason,status,created_at,updated_at,recommendation_snapshot_json,request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                               (identifier,building,start,end,'Asia/Shanghai',payload['operator_id'],payload['hvac_setpoint_c'],
                                payload['storage_mode'],payload['storage_power_kw'],payload['reason'],status,
                                iso_time(now),iso_time(now),canonical(snapshot),request_id))
            result = decode(connection.execute('SELECT * FROM takeovers WHERE id=?',(identifier,)).fetchone())
            for at in range(start,end,HOUR_MS):
                self.dispatch(connection,result,at)
            self.audit(connection,payload['operator_id'],'create',identifier,after=result,request_id=request_id)
            return result

    def cancel(self, identifier, operator, reason, expected_version=None):
        with self.db.transaction() as connection:
            self.expire(connection)
            before = decode(connection.execute('SELECT * FROM takeovers WHERE id=?',(identifier,)).fetchone())
            if before is None:
                raise Missing('接管记录不存在')
            if before['cancelled_ms'] is not None:
                return before
            if expected_version is not None and before['version'] != expected_version:
                raise Conflict('接管记录已更新，请刷新后重试')
            now=self.clock()
            connection.execute("UPDATE takeovers SET status='cancelled',cancelled_at=?,cancelled_ms=?,cancelled_by=?,cancel_reason=?,updated_at=?,version=version+1 WHERE id=?",
                               (iso_time(now),int(now.timestamp()*1000),operator,reason,iso_time(now),identifier))
            after=decode(connection.execute('SELECT * FROM takeovers WHERE id=?',(identifier,)).fetchone())
            self.audit(connection,operator,'cancel',identifier,before,after)
            return after

    def update(self, identifier, payload, snapshot, expected_version):
        start=hour_ms(payload['date'],payload['hour'])
        end=start+payload['duration_hours']*HOUR_MS
        with self.db.transaction() as connection:
            self.expire(connection)
            before=decode(connection.execute('SELECT * FROM takeovers WHERE id=?',(identifier,)).fetchone())
            if before is None:
                raise Missing('接管记录不存在')
            now=self.clock()
            if before['version']!=expected_version:
                raise Conflict('接管记录已更新，请刷新后重试')
            if before['status']!='active' or min(before['start_ms'],start)<=int(now.timestamp()*1000):
                raise Conflict('已开始的接管不能修改，请撤销后另建配置')
            if before['building_id']!=snapshot['building_id']:
                raise Conflict('不能变更楼宇')
            self.overlap(connection,before['building_id'],start,end,identifier)
            connection.execute('UPDATE takeovers SET start_ms=?,end_ms=?,operator_id=?,hvac_setpoint_c=?,storage_mode=?,storage_power_kw=?,reason=?,updated_at=?,version=version+1,recommendation_snapshot_json=? WHERE id=?',
                               (start,end,payload['operator_id'],payload['hvac_setpoint_c'],payload['storage_mode'],payload['storage_power_kw'],payload['reason'],iso_time(now),canonical(snapshot),identifier))
            after=decode(connection.execute('SELECT * FROM takeovers WHERE id=?',(identifier,)).fetchone())
            for at in range(start,end,HOUR_MS):
                self.dispatch(connection,after,at)
            self.audit(connection,payload['operator_id'],'update',identifier,before,after)
            return after

    def get_active(self, date, hour, building_id=None):
        """Decision lookup: any cancellation immediately removes the override."""
        return self._lookup(date, hour, building_id, include_cancelled=False)

    def get_for_display(self, date, hour, building_id=None):
        """Preserve hour-start cancellation history, without a manual status alias."""
        return self._lookup(date, hour, building_id, include_cancelled=True)

    def _lookup(self, date, hour, building_id, include_cancelled):
        at = hour_ms(date, hour)
        with self.db.transaction() as connection:
            self.expire(connection)
            sql = 'SELECT * FROM takeovers WHERE start_ms<=? AND end_ms>?'
            args = [at, at]
            if include_cancelled:
                sql += ' AND (cancelled_ms IS NULL OR cancelled_ms>?)'
                args.append(at)
            else:
                sql += ' AND cancelled_ms IS NULL AND status!=\'cancelled\''
            if building_id:
                sql += ' AND building_id=?'
                args.append(building_id)
            # A newer valid override takes precedence over a cancelled display record.
            row = connection.execute(sql+' ORDER BY (cancelled_ms IS NULL) DESC,created_at DESC,id DESC LIMIT 1', args).fetchone()
            result = decode(row)
            if result is None:
                return None
            return {**result, 'record_status': result['status'],
                    'status': 'cancelled' if result['cancelled_ms'] is not None else 'manual'}

    def history(self, date, limit=100, offset=0):
        start, end = day_bounds(date)
        with self.db.transaction() as connection:
            self.expire(connection)
            return [decode(r) for r in connection.execute('SELECT * FROM takeovers WHERE start_ms<? AND end_ms>? ORDER BY start_ms,id LIMIT ? OFFSET ?', (end,start,limit,offset))]

    def receipts(self, date, hour):
        at = hour_ms(date,hour)
        with self.db.transaction() as connection:
            # Receipts are immutable history, including superseded/cancelled records.
            rows = connection.execute('SELECT d.*, CASE WHEN d.source=\'agent\' THEN 1 ELSE t.start_ms<=d.hour_start_ms AND t.end_ms>d.hour_start_ms AND (t.cancelled_ms IS NULL OR t.cancelled_ms>d.hour_start_ms) AND t.version=d.takeover_version END AS effective FROM dispatch_log d LEFT JOIN takeovers t ON t.id=d.takeover_id WHERE d.hour_start_ms=? ORDER BY d.created_at,d.batch_id,d.destination', (at,)).fetchall()
            result = []
            for row in rows:
                item = dict(row)
                item['effective'] = bool(item['effective'])
                item['command'] = json.loads(item.pop('command_json'))
                item['receipt'] = json.loads(item.pop('receipt_json'))
                result.append(item)
            return result

    def record_agent_dispatch(self, date, hour, building_id, commands, receipt, request_id):
        """Model-session hook: store an existing Agent log receipt, never call devices."""
        at=hour_ms(date,hour)
        if not request_id or not isinstance(receipt,dict) or len(commands)!=2:
            raise ValueError('invalid dispatch record')
        if {c.get('destination') for c in commands}!={'BA','EMS'}:
            raise ValueError('BA and EMS records required')
        # Check the payload before any writes. This API records log-only receipts.
        for item in commands:
            command=item['command']
            value=command.get('setpoint_c') if item['destination']=='BA' else command.get('battery_kw')
            if not finite(value) or (not 24<=value<=27 if item['destination']=='BA' else abs(value)>500):
                raise ValueError('invalid dispatch control')
        if receipt.get('transport')!='log_only' or receipt.get('device_connected') is not False:
            raise ValueError('only log receipts are supported')
        with self.db.transaction() as connection:
            for item in commands:
                key=f'agent:{building_id}:{at}:{request_id}:{item["destination"]}'
                old=connection.execute('SELECT command_json,receipt_json FROM dispatch_log WHERE idempotency_key=?',(key,)).fetchone()
                if old:
                    if old['command_json']!=canonical(item['command']) or old['receipt_json']!=canonical(receipt):
                        raise Conflict('dispatch idempotency conflict')
                    continue
                connection.execute('INSERT INTO dispatch_log VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                                   (str(uuid.uuid4()),request_id,building_id,at,item['destination'],'agent',None,None,
                                    canonical(item['command']),canonical(receipt),'recorded',iso_time(self.clock()),key))

    def record_receipt_view(self, operator, date, hour, response):
        public_text(operator)
        with self.db.transaction() as connection:
            self.audit(connection,operator,'view_receipt',f'{date}:{hour:02d}',after=response)

    def audits(self,date,limit=100,offset=0,entity_type=None):
        start,end=day_bounds(date)
        from datetime import datetime, timezone
        bounds=[iso_time(datetime.fromtimestamp(t/1000,timezone.utc)) for t in (start,end)]
        if entity_type is not None and entity_type not in ('takeover','receipt','chat'):
            raise ValueError('unsupported audit entity type')
        predicate = "entity_type IN ('takeover','receipt')" if entity_type is None else 'entity_type=?'
        args = (*bounds,limit,offset) if entity_type is None else (*bounds,entity_type,limit,offset)
        with self.db.transaction() as connection:
            result=[]
            for row in connection.execute('SELECT * FROM audit_log WHERE occurred_at>=? AND occurred_at<? AND '+predicate+' ORDER BY id LIMIT ? OFFSET ?',args):
                item=dict(row)
                for key in ('before','after'):
                    value=item.pop(key+'_json')
                    item[key]=json.loads(value) if value is not None else None
                result.append(item)
            return result
