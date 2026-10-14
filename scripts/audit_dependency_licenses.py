"""Reproducible installed Python metadata/text and read-only frontend lock audit."""
import hashlib,json,re,subprocess,sys,tempfile,venv,os
from importlib import metadata

CONCLUSION='未使用 GPL/AGPL 许可的依赖；部分科学计算运行库带 GCC 运行库例外'


def package_snapshot():
    return sorted((r.metadata['Name'].lower(),r.version) for r in metadata.distributions())


def audit_in_temporary_venv(out):
    before=package_snapshot()
    env={k:v for k,v in os.environ.items() if not k.startswith(('LLM_','OPENAI_','ANTHROPIC_','AGNES_','PIP_')) and k not in ('PYTHONPATH','VIRTUAL_ENV','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY')}
    with tempfile.TemporaryDirectory(prefix='agnes-license-') as directory:
        path=Path(directory);venv.EnvBuilder(with_pip=True).create(path)
        python=path/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
        subprocess.run([str(python),'-m','pip','--isolated','install','--quiet','--disable-pip-version-check','--index-url','https://pypi.org/simple','pip-licenses==5.5.5'],check=True,env=env,capture_output=True)
        # Audit project interpreter, not the temporary tool environment.
        for filename,flags in [('python_license_inventory_v2.json',['--with-urls']),('python_license_texts_v2.json',['--with-license-file','--no-license-path'])]:
            subprocess.run([str(python),'-m','piplicenses','--python',sys.executable,'--format=json',*flags,f'--output-file={out/filename}'],check=True,env=env,capture_output=True)
        version=subprocess.check_output([str(python),'-m','piplicenses','--version'],text=True,env=env).strip()
    assert not path.exists() and before==package_snapshot()
    return version,dict(temporary_venv_deleted=True,global_packages_unchanged=True,target='project interpreter via --python',tool_installed_globally=False)
from pathlib import Path


def main():
    out=Path('experiments');out.mkdir(exist_ok=True)
    version,isolation=audit_in_temporary_venv(out)
    py=json.loads((out/'python_license_inventory_v2.json').read_text());texts=json.loads((out/'python_license_texts_v2.json').read_text())
    lock=Path('twin/package-lock.json');packages=json.loads(lock.read_text(encoding='utf-8'))['packages']
    front=[dict(name=k.split('node_modules/')[-1],version=v.get('version'),license=v.get('license','UNKNOWN'),dev=bool(v.get('dev'))) for k,v in packages.items() if k]
    (out/'frontend_license_inventory_v2.json').write_text(json.dumps(front,indent=2),encoding='utf-8')
    gpl=lambda s:bool(re.search(r'GPL|General Public',s,re.I))
    summary=dict(status='metadata_pass_with_bundled_license_caveats',conclusion=CONCLUSION,isolation=isolation,tool=version,python_packages=len(py),frontend_lock_entries=len(front),
        python_gpl_agpl_metadata=[r['Name'] for r in py if gpl(r['License'])],frontend_gpl_agpl_metadata=[r['name'] for r in front if gpl(r['license'])],
        unknown_python=[r['Name'] for r in py if r['License']=='UNKNOWN'],unknown_frontend=[r['name'] for r in front if r['license']=='UNKNOWN'],
        bundled_gnu_text_references=[r['Name'] for r in texts if re.search(r'GPL|GNU ',r['LicenseText'])],
        blanket_no_gpl_confirmed=False,caveats=['NumPy/SciPy GCC-exception runtime','FreeType FTL OR GPL choice: FTL','Pillow source/build/XZ notices: artifact-level verification open'],
        frontend_lock_sha256=hashlib.sha256(lock.read_bytes()).hexdigest(),
        requirements_sha256=hashlib.sha256(Path('requirements.txt').read_bytes()).hexdigest(),
        inventory_sha256={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [out/'python_license_inventory_v2.json',out/'python_license_texts_v2.json',out/'frontend_license_inventory_v2.json']})
    (out/'dependency_license_audit_v2.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    print(json.dumps(summary));assert not any(summary[k] for k in ['python_gpl_agpl_metadata','frontend_gpl_agpl_metadata','unknown_python','unknown_frontend'])
    return summary


if __name__=='__main__':main()
