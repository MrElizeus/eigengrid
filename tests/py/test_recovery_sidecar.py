import importlib.util
import json
import os
from pathlib import Path
import pytest

spec=importlib.util.spec_from_file_location('sidecar',Path(__file__).resolve().parents[2]/'scripts/operations/recovery-sidecar.py')
sidecar=importlib.util.module_from_spec(spec);spec.loader.exec_module(sidecar)

def fixture(tmp_path,monkeypatch):
 tmp_path.chmod(0o700);source=tmp_path/'source';source.mkdir();secret=source/'configuration.json';secret.write_text('{"credential":"PRIVATE_TEST_MARKER"}');secret.chmod(0o600)
 original=sidecar.allowed_source;monkeypatch.setattr(sidecar,'allowed_source',lambda path:str(path).startswith(str(source)+'/'))
 policy={'schemaVersion':sidecar.POLICY_SCHEMA,'actors':['scientist'],'metadata':{'crossComponentAtomic':False},'files':[{'path':str(secret),'role':'configuration','uid':os.getuid()}]}
 return policy,secret,original

def test_capture_preserves_bytes_modes_acl_metadata_without_activation(tmp_path,monkeypatch):
 policy,secret,_=fixture(tmp_path,monkeypatch);output=tmp_path/'backup';result=sidecar.create(policy,output)
 assert result['verified'] and result['restorePolicy']=='quarantine-only-no-service-or-session-activation' and not result['crossComponentAtomic']
 manifest=json.loads((output/'sidecar-manifest.json').read_text());entry=manifest['files'][0]
 assert entry['uid']==os.getuid() and entry['mode']==0o600 and 'aclAccessBase64' in entry
 assert (output/entry['path']).read_bytes()==secret.read_bytes()
 assert sidecar.verify(output)==result
 assert secret.read_text()=='{"credential":"PRIVATE_TEST_MARKER"}'

@pytest.mark.parametrize('change',['tamper','extra','symlink','missing'])
def test_payload_corruption_and_membership_fail(tmp_path,monkeypatch,change):
 policy,secret,_=fixture(tmp_path,monkeypatch);output=tmp_path/'backup';sidecar.create(policy,output);payload=output/'payload/0000.bin'
 if change=='tamper':payload.write_text('corrupt')
 if change=='extra':(output/'extra').write_text('unexpected')
 if change=='symlink':payload.unlink();payload.symlink_to(secret)
 if change=='missing':payload.unlink()
 with pytest.raises((ValueError,OSError)):sidecar.verify(output)

def test_reviewed_namespaces_exclude_other_apps_and_traversal():
 assert sidecar.allowed_source('/etc/eigengrid/llm.json')
 assert sidecar.allowed_source('/home/scientist/.eigengrid/mission-http.json')
 assert not sidecar.allowed_source('/etc/shadow')
 assert not sidecar.allowed_source('/etc/eigengrid/../shadow')
 assert not sidecar.allowed_source('/home/scientist/.ssh/id_ed25519')

def test_symlink_hardlink_overwrite_and_bounds_fail_without_publication(tmp_path,monkeypatch):
 policy,secret,_=fixture(tmp_path,monkeypatch);alias=secret.parent/'alias.json';alias.symlink_to(secret);policy['files'][0]['path']=str(alias)
 with pytest.raises(ValueError):sidecar.create(policy,tmp_path/'backup')
 policy['files'][0]['path']=str(secret);os.link(secret,secret.parent/'hardlink')
 with pytest.raises(ValueError):sidecar.create(policy,tmp_path/'backup')
 (secret.parent/'hardlink').unlink();monkeypatch.setattr(sidecar,'MAX_TOTAL',2)
 with pytest.raises(ValueError):sidecar.create(policy,tmp_path/'backup')
 assert not (tmp_path/'backup').exists() and not list(tmp_path.glob('.sidecar-*'))

def test_no_overwrite_of_existing_snapshot(tmp_path,monkeypatch):
 policy,_,_=fixture(tmp_path,monkeypatch);output=tmp_path/'backup';sidecar.create(policy,output)
 with pytest.raises(FileExistsError):sidecar.create(policy,output)
