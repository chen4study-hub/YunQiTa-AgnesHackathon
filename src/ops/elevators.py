"""Source-date-bound continuous lift trips; offsets are milliseconds from midnight."""
import hashlib
import math
from datetime import date
from .config import (DAY_MS, HOUR_MS, FLOOR_HEIGHT_M, MAX_SPEED_M_S,
                     ACCELERATION_M_S2, LIFT_IDS, keyed, decimal1)


def motion(from_floor, to_floor):
    distance = abs(to_floor - from_floor) * FLOOR_HEIGHT_M
    accel = min(MAX_SPEED_M_S / ACCELERATION_M_S2,
                math.sqrt(distance / ACCELERATION_M_S2))
    cruise = max(0.0, (distance - ACCELERATION_M_S2 * accel**2) / MAX_SPEED_M_S)
    return accel, cruise, 2 * accel + cruise


def travel_ms(a, b):
    return math.ceil(motion(a, b)[2] * 1000)


def state_at(lift, offset_ms):
    floor = lift['initial_floor']
    for trip in lift['trips']:
        if offset_ms < trip['depart_ms']:
            break
        floor = trip['to_floor']
        if offset_ms < trip['arrive_ms']:
            a, cruise, duration = motion(trip['from_floor'], trip['to_floor'])
            # Stretch the physical curve to the integer-ms duration, never compress it.
            seconds = (offset_ms - trip['depart_ms']) / (trip['arrive_ms'] - trip['depart_ms']) * duration
            speed = ACCELERATION_M_S2 * a
            if seconds < a:
                distance = .5 * ACCELERATION_M_S2 * seconds**2
            elif seconds < a + cruise:
                distance = .5 * ACCELERATION_M_S2 * a**2 + speed * (seconds-a)
            else:
                distance = abs(trip['to_floor']-trip['from_floor']) * FLOOR_HEIGHT_M - .5 * ACCELERATION_M_S2 * (duration-seconds)**2
            sign = 1 if trip['to_floor'] > trip['from_floor'] else -1
            return {'id':lift['id'],'floor':trip['from_floor']+sign*distance/FLOOR_HEIGHT_M,
                    'target':trip['to_floor'],'status':'up' if sign > 0 else 'down',
                    'direction':sign,'load_pct':trip['load_pct']}
        if offset_ms < trip['arrive_ms'] + trip['dwell_ms']:
            return {'id':lift['id'],'floor':float(floor),'target':floor,
                    'status':'doors','direction':0,'load_pct':trip['load_pct']}
    return {'id':lift['id'],'floor':float(floor),'target':floor,
            'status':'idle','direction':0,'load_pct':0.0}


def dispatch_interval(zone_people, hour):
    """Per-car interval scales inversely with occupants; quantized to 30 seconds."""
    base = 270000 if 7 <= hour <= 9 or 17 <= hour <= 19 else 540000 if 11 <= hour <= 14 else 900000 if 6 <= hour <= 21 else 1800000
    if not zone_people:
        return None
    return min(3600000, max(base, math.ceil(base * 1700 / zone_people / 30000) * 30000))


def service_mode(offset_ms):
    minute = offset_ms / 60000
    if 7*60 <= minute < 10*60 or 12*60+45 <= minute < 13*60+30:
        return 'inbound'
    if 17*60 <= minute < 20*60 or 11*60+30 <= minute < 12*60+15:
        return 'outbound'
    return 'exchange'


def fleet(source_date, hours):
    result = []
    workday = date.fromisoformat(source_date).weekday() < 5 and not source_date.endswith('-07-04')
    boundaries = sorted({*range(0, DAY_MS+1, HOUR_MS),
                         450*60000, 570*60000, 1050*60000, 1140*60000,
                         599*60000, 690*60000, 735*60000, 765*60000, 810*60000})
    for index,lift_id in enumerate(LIFT_IDS):
        low = lift_id.startswith('L')
        stops = list(range(1,21)) if low else [1]+list(range(21,41))
        seed = hashlib.sha256(f'{source_date}|{lift_id}'.encode()).hexdigest()
        trips, cursor, current = [], 0, 1
        sequence, was_busy = 0, False

        def add(target, passengers, dwell):
            nonlocal cursor,current
            if target == current:
                cursor += dwell
                return
            duration = travel_ms(current,target)
            if cursor+duration+dwell > DAY_MS:
                raise ValueError('lift route exceeds day')
            trips.append({'depart_ms':cursor,'from_floor':current,'to_floor':target,
                          'arrive_ms':cursor+duration,'dwell_ms':dwell,
                          'load_pct':decimal1(passengers/20*100),'passengers':passengers})
            cursor += duration+dwell
            current = target

        for start,end in zip(boundaries,boundaries[1:]):
            h = start//HOUR_MS
            floors = hours[h]['floors']
            candidates = stops[1:]
            zone_people = sum(floors[f-1]['occupancy_people'] for f in candidates)
            interval = dispatch_interval(zone_people,h)
            mode = service_mode(start)
            # Busy directional service is completion-driven, not clock-dispatched.
            minute = start / 60000
            busy_window = 450 <= minute < 570 or 1050 <= minute < 1140 or 690 <= minute < 735 or 765 <= minute < 810
            busy = busy_window and zone_people >= 900
            building_people = sum(f['occupancy_people'] for f in floors)
            daytime_flow = workday and 599 <= minute < 960 and building_people > 1000
            continuous = busy and not daytime_flow
            if daytime_flow:
                # Three coordinated cars alternate distant occupied floors.
                # Group launches overlap movement, while each car has ample
                # time to open doors before its next turn. Visitor/lunch legs
                # additionally serve the lobby. No hourly return-to-lobby gap.
                endpoints = [min(candidates),max(candidates)]
                span = travel_ms(*endpoints)
                # More occupants increase dispatch frequency, but the minimum
                # overlap guarantees coverage once the daytime flow is enabled.
                day_people = max(sum(r['floors'][f-1]['occupancy_people'] for f in candidates) for r in hours[10:16])
                spacing = math.floor(span * max(.65,min(.85,1500/day_people)))
                interval = 3*spacing
            if interval is None:
                was_busy = False
                continue
            if continuous:
                if not was_busy:
                    cursor = max(cursor,start) + (index%3)*17000 + int(keyed(source_date,lift_id,'phase')*5000)
                else:
                    cursor = max(cursor,start)
                slot = cursor
            else:
                phase = (index%3)*spacing if daytime_flow else (index%3)*interval//3 + int(keyed(source_date,lift_id,'phase')*5000)
                slot = math.ceil((max(start,cursor)-phase)/interval)*interval+phase
            while slot < end and slot < DAY_MS-180000:
                cursor = max(cursor,slot)
                token = f'{h}:{sequence}'
                sequence += 1
                load = min(20,max(1,round(zone_people/70)))
                if daytime_flow:
                    lower,upper = min(candidates),max(candidates)
                    if mode != 'exchange' or sequence%5 == 0:
                        lower = 1
                    target = lower if current > (min(candidates)+upper)/2 else upper
                    passengers = min(20,max(1,round(zone_people/150)))
                    if (mode == 'outbound' and target > current) or (mode == 'inbound' and target < current):
                        passengers = 0
                    add(target,passengers,7000)
                    slot += interval
                    continue
                occupied = [f for f in candidates if floors[f-1]['occupancy_people'] > 0]
                # Shared destinations: 1..2 stops from party size and served floors.
                party = max(1,math.ceil(len(occupied)/2))
                count = min(2,len(occupied),max(1,math.ceil(load/party)))
                ranked = sorted(occupied,key=lambda f:(-math.log(max(1e-12,keyed(source_date,lift_id,token+f':stop:{f}')))/(floors[f-1]['occupancy_people']+1),f))
                if busy:
                    # The high occupied floor anchors a sweep across the zone.
                    terminal = max(occupied)
                    selected = sorted([terminal]+[f for f in ranked if f != terminal][:count-1])
                else:
                    selected = sorted(ranked[:count if mode != 'exchange' else 2])
                weights = [floors[f-1]['occupancy_people']+1 for f in selected]
                exact = [load*w/sum(weights) for w in weights]
                parts = [math.floor(v) for v in exact]
                order = sorted(range(len(parts)),key=lambda i:(-(exact[i]-parts[i]),i))
                for i in order[:load-sum(parts)]:
                    parts[i] += 1
                counts = dict(zip(selected,parts))
                def doors(target):
                    return 6000 + int(keyed(source_date,lift_id,token+f':doors:{target}')*2001)
                lobby_time = max(doors(1),load*1200)
                if busy and mode == 'inbound' and current == 1 and trips and slot == trips[-1]['arrive_ms']+trips[-1]['dwell_ms']:
                    # A new hourly demand can change the next load: boarding
                    # belongs to this departure, not the preceding cycle.
                    trips[-1]['dwell_ms'] = lobby_time
                    cursor = trips[-1]['arrive_ms']+lobby_time
                if mode == 'inbound':
                    if current != 1:
                        add(1,0,lobby_time)
                    elif not trips:
                        cursor += lobby_time
                    remaining = load
                    for target in selected:
                        add(target,remaining,doors(target))
                        remaining -= counts[target]
                    # Lobby dwell is next cycle's boarding time (no extra gap).
                    add(1,0,lobby_time)
                elif mode == 'outbound':
                    if current != 1:
                        add(1,0,doors(1))
                    remaining = 0
                    for target in reversed(selected):
                        add(target,remaining,doors(target))
                        remaining += counts[target]
                    add(1,remaining,lobby_time)
                else:
                    if sequence%2:
                        selected.reverse()
                    remaining = min(load,8+int(keyed(source_date,lift_id,token+':load')*8))
                    for target in selected:
                        add(target,remaining,doors(target))
                        delta = int(keyed(source_date,lift_id,token+f':{target}:exchange')*7)-3
                        remaining = max(0,min(20,remaining+delta))
                slot = cursor if continuous else slot+interval
            if mode == 'exchange' and not daytime_flow and current != 1:
                add(1,0,6000)
            was_busy = continuous
        if current != 1:
            add(1,0,6000)
        result.append({'id':lift_id,'zone':'low' if low else 'high','stops':stops,
                       'initial_floor':1,'capacity_people':20,'seed_sha256':seed,'trips':trips})
    return result
