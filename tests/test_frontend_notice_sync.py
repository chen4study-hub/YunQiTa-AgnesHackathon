from pathlib import Path
import pytest
from scripts.sync_frontend_notices import SOURCE,TARGET,BEGIN,END,source_section,sync


def test_frontend_embedded_section_is_byte_identical_and_check_read_only():
    before=TARGET.read_bytes();original=SOURCE.read_bytes()
    assert before.split(BEGIN)[1].split(END)[0]==SOURCE.read_bytes()==source_section(SOURCE)
    sync(check=True)
    assert TARGET.read_bytes()==before and SOURCE.read_bytes()==original


def test_sync_preserves_python_data_and_suffix_and_is_idempotent(tmp_path):
    source=tmp_path/'source.txt';target=tmp_path/'target.txt'
    source.write_bytes(b'data notice ignored\nThird-party license notices\r\nexact\nbytes\r\n')
    prefix=b'Python and data notices\r\n'
    target.write_bytes(prefix+b'Third-party license notices\nold manual text')
    sync(source,target);first=target.read_bytes();assert first==prefix+BEGIN+source_section(source)+END
    sync(source,target);assert target.read_bytes()==first
    target.write_bytes(first+b'future root-owned notes\n')
    source.write_bytes(source.read_bytes()+b'new upstream license')
    with pytest.raises(ValueError,match='drift'):sync(source,target,check=True)
    sync(source,target)
    assert target.read_bytes()==prefix+BEGIN+source_section(source)+END+b'future root-owned notes\n'
