"""Render saved diagnostic evidence, not imagined uncertainty."""
import json
from pathlib import Path
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt


def save(fig,name):
    out=Path('experiments/figures');out.mkdir(parents=True,exist_ok=True)
    fig.savefig(out/(name+'.png'),dpi=180,bbox_inches='tight')
    fig.savefig(out/(name+'.svg'),bbox_inches='tight')
    plt.close(fig)


def main():
    d=json.loads(Path('experiments/coverage_diagnosis.json').read_text())
    keys=list(d['by_building']);values=[d['by_building'][k] for k in keys]
    y=np.arange(len(keys));p=np.array([v['coverage'] for v in values]);ci=np.array([v['ci95_exact'] for v in values])
    fig,ax=plt.subplots(figsize=(9,4),layout='constrained')
    ax.errorbar(p*100,y,xerr=np.vstack([p-ci[:,0],ci[:,1]-p])*100,fmt='o',capsize=4)
    ax.set_yticks(y,keys);ax.axvline(90.5,ls='--',color='black',label='nominal 90.5%')
    ax.set(xlabel='Retained empirical coverage (%)',title='2016 six-building test: exact binomial CIs (IID assumption)')
    ax.legend();save(fig,'building_coverage')
    w=d['by_week'];x=list(w);p=np.array([v['coverage'] for v in w.values()])*100
    fig,ax=plt.subplots(figsize=(9,3.5),layout='constrained')
    ax.plot(x,p,'o-',label='weekly retained PICP');ax.axhline(90.5,ls='--',color='black')
    ax.set(ylim=(80,100),ylabel='Coverage (%)',xlabel='Week start',title='Frozen calibration: no monotonic decline in this test')
    ax.tick_params(axis='x',rotation=30);ax.legend();save(fig,'weekly_coverage')
    t=pd.read_csv('experiments/transfer_curve.csv')
    fig,ax=plt.subplots(figsize=(6,3.5),layout='constrained')
    ax.plot(t.weeks,t.retained_picp*100,'o-',label='retained PICP');ax.axhline(90.5,ls='--',color='black',label='nominal')
    ax.set(xlabel='Local calibration weeks',ylabel='Coverage (%)',title='Billi transfer: no tested window reaches target')
    ax.legend();save(fig,'transfer_curve')
    o=pd.read_csv('experiments/byron_operating_points.csv').sort_values('rejection_rate')
    fig,(ax,bx)=plt.subplots(1,2,figsize=(9,3.5),layout='constrained')
    ax.plot((1-o.rejection_rate)*100,o.retained_picp*100,'o-');ax.axhline(90.5,ls='--',color='black')
    ax.set(xlabel='Actual retained share (%)',ylabel='Retained coverage (%)',title='Byron validation-selected CQR profile')
    bx.plot((1-o.rejection_rate)*100,o.retained_mae,'o-');bx.set(xlabel='Actual retained share (%)',ylabel='Retained MAE (kW)',title='Honest risk-coverage trade-off')
    save(fig,'operating_points')
    print('saved 4 evidence figures as PNG + SVG')


if __name__=='__main__':main()
