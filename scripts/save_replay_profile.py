"""Persist the validation-selected CQR replay bundle and bind cache provenance.

Rebuild fixed quantile fits with the same seed/training data; compare old cached
predictions before replacing nothing. This is verification, not additional search.
"""
import hashlib
import json
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from scripts.search_byron import fit_quantiles
from src.data.adapter import adapt, config
from src.models.residual import ResidualForecaster
from src.conformal.replay_calibration import primitives, run


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    version='byron2017-v1-cqr'
    artifact=Path(f'models/{version}.joblib')
    if artifact.exists(): raise FileExistsError('immutable replay artifact already exists')
    c=config('configs/byron2017.yaml')
    frame=adapt(pd.read_csv('data/byron2017.csv'),c)
    t=sorted(frame.timestamp.unique());a,b=int(len(t)*.65),int(len(t)*.85)
    frozen=ResidualForecaster.load('models/byron2017-v1.joblib')
    f=primitives(frozen,frame)
    ct=t[a:b];cq=f[f.timestamp.isin(ct[int(len(ct)*.65):])].copy()
    qmodels=fit_quantiles(frozen,frame[frame.timestamp.isin(t[:a])])
    profiles=json.loads(Path('experiments/byron_selected_profiles.json').read_text())
    caches={}
    for rho in (.10,.15,.20,.28,.30):
        choice=profiles[str(rho)]
        regenerated=run(frozen,cq,f[f.timestamp.isin(t[b:])].sort_values('timestamp'),rho,
                        choice['method'],weeks=choice['weeks'],quantile_models=qmodels)
        file=Path(f'data/byron_test_rejection_{int(rho*100)}.csv')
        existing=pd.read_csv(file)
        for col in ('point','lower','upper','risk_score'):
            if not np.allclose(existing[col],regenerated[col],rtol=1e-10,atol=1e-10):
                raise ValueError('cached predictions do not match frozen bundle: '+col)
        if not np.array_equal(existing.abstain,regenerated.abstain): raise ValueError('gate mismatch')
        caches[str(rho)]={'path':str(file),'sha256':sha(file)}
    bundle={'version':version,'mode':'shadow','backbone':frozen,'quantile_models':qmodels,
            'calibration':cq,'profiles':profiles,'test_start':str(t[b]),
            'point_model_fit_end':str(t[a-1]),'quantile_fit_end':str(t[a-1]),
            'calibration_end':str(t[b-1]),'data_sha256':sha('data/byron2017.csv')}
    joblib.dump(bundle,artifact)
    provenance={'model_version':version,'artifact':str(artifact),'artifact_sha256':sha(artifact),
                'point_artifact_sha256':sha('models/byron2017-v1.joblib'),
                'data_sha256':sha('data/byron2017.csv'),
                'profile_selection_sha256':sha('experiments/byron_selected_profiles.json'),
                'campus_artifact':'models/hog2017-v1.joblib',
                'campus_artifact_sha256':sha('models/hog2017-v1.joblib'),
                'campus_input':'data/hog2017_cohort.csv',
                'campus_input_sha256':sha('data/hog2017_cohort.csv'),
                'test_start':str(t[b]),'calibration_end':str(t[b-1]),'caches':caches}
    Path('experiments/replay_provenance.json').write_text(json.dumps(provenance,indent=2),encoding='utf-8')
    print('verified and saved',version,provenance['artifact_sha256'])


if __name__=='__main__':main()
