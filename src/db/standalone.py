"""Isolated API factory for tests and probes; never imports the resident app."""
from fastapi import FastAPI
from src.api.takeover_router import router, get_service
from src.db import Database, Repository, TakeoverService


def create_app(path=None, clock=None, evidence=None):
    service=TakeoverService(Repository(Database(path),clock),evidence)
    app=FastAPI(title='Yunqi takeover isolated API')
    app.dependency_overrides[get_service]=lambda: service
    app.include_router(router)
    return app


def main():
    import argparse
    import tempfile
    from pathlib import Path
    import uvicorn
    parser=argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=8127)
    args=parser.parse_args()
    if not 8100<args.port<65536:
        parser.error('port must be above 8100')
    with tempfile.TemporaryDirectory(prefix='yunqi-takeover-') as directory:
        uvicorn.run(create_app(Path(directory)/'probe.db'),host='127.0.0.1',port=args.port)


if __name__=='__main__':
    main()
