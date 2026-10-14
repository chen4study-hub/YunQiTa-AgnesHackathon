"""Shared contract validation, deterministic packaging and size budgets."""
import copy
import gzip
import json
from decimal import Decimal
from jsonschema import Draft202012Validator, FormatChecker
from .config import ROOT, RAW_LIMIT, GZIP_LIMIT, canonical, digest


def validate(raw):
    schema = json.loads((ROOT/'contracts/ops.schema.json').read_bytes(),parse_float=Decimal)
    instance = json.loads(raw,parse_float=Decimal)
    kind=instance.get('kind')
    branch=next((b for b in schema['oneOf'] if b['properties']['kind']['const']==kind),None)
    if branch is None: raise ValueError('unknown document kind')
    Draft202012Validator({**branch,'$defs':schema['$defs']},format_checker=FormatChecker()).validate(instance)


def check_size(raw,name):
    zipped=gzip.compress(raw,compresslevel=9,mtime=0)
    if len(raw)>RAW_LIMIT or len(zipped)>GZIP_LIMIT:
        raise ValueError(f'{name} exceeds size budget: {len(raw)}/{len(zipped)}')
    return {'file':name,'raw_bytes':len(raw),'gzip_bytes':len(zipped),'sha256':digest(raw)}


def encode_day(day):
    day=copy.deepcopy(day)
    name=day['meta']['scenario']+'.ops.json'
    raw=canonical(day)
    if len(raw)<=RAW_LIMIT and len(gzip.compress(raw,compresslevel=9,mtime=0))<=GZIP_LIMIT:
        validate(raw)
        return {name:raw}
    part={'schema_version':'1.0','kind':'floors','scenario':day['meta']['scenario'],
          'source_date':day['meta']['source_date'],
          'hours':[{'offset_ms':h['offset_ms'],'floors':h.pop('floors')} for h in day['hours']],
          'history':[{'offset_ms':h['offset_ms'],'floors':h.pop('floors')} for h in day['history']['hours']]}
    part_name=day['meta']['scenario']+'.ops-floors.json'
    part_raw=canonical(part)
    day['meta']['floors_file']=part_name
    day['meta']['floors_sha256']=digest(part_raw)
    raw=canonical(day)
    validate(raw);validate(part_raw)
    return {name:raw,part_name:part_raw}


