"""Owned offline harness controls; zero Runner/provider/database-service operations."""
import copy
import os
from pathlib import Path
import socket
import sqlite3
import tempfile
import unittest
from qualification_harness import (
    phase_environment, audit_mounts, bubblewrap_args, logical_snapshot,
    compare_snapshots, receipt_hash, require_prepublication_observations,
    require_replay_time, config_tree_snapshot, prepublication_capture_gate,
)


class HarnessControls(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.env = {'HOME': str(self.root), 'PATH': '/usr/bin:/bin',
                    'TMPDIR': str(self.root), 'NO_COLOR': '1', 'DATABASE_URL': 'reader-fixture'}
        self.roles = {'DATABASE_URL': 'reader', 'SYNAPSOR_DATABASE_WRITE_URL': 'writer',
                      'SYNAPSOR_SETUP_DATABASE_URL': 'administrator', 'OPENROUTER_API_KEY': 'provider'}
        self.mount = {'source': str(self.root), 'target': '/owned/project', 'mode': 'rw'}

    def tearDown(self):
        self.tmp.cleanup()

    def test_extra_admin_refused_before_child(self):
        started = []
        def start():
            phase_environment('authoring', {**self.env, 'SYNAPSOR_SETUP_DATABASE_URL': 'admin-fixture'}, self.roles)
            started.append(True)
        with self.assertRaisesRegex(ValueError, 'PHASE_ENV_EXTRA_REFERENCE'):
            start()
        self.assertEqual(started, [])

    def test_reader_survives_without_inherited_secret(self):
        os.environ['SYNAPSOR_SETUP_DATABASE_URL'] = 'synthetic-inherited-only'
        try:
            result = phase_environment('authoring', self.env, self.roles)
            self.assertEqual(result['DATABASE_URL'], 'reader-fixture')
            self.assertNotIn('SYNAPSOR_SETUP_DATABASE_URL', result)
        finally:
            os.environ.pop('SYNAPSOR_SETUP_DATABASE_URL')

    def test_every_phase_credential_set(self):
        expected = {'authoring': {'reader', 'provider'}, 'mcp': {'reader'},
                    'worker': {'writer'}, 'verifier': {'reader', 'writer'},
                    'administrator': {'administrator'}}
        base = {k:v for k,v in self.env.items() if k != 'DATABASE_URL'}
        for phase, roles in expected.items():
            for name, role in self.roles.items():
                with self.subTest(phase=phase, role=role):
                    if role in roles:
                        self.assertIn(name, phase_environment(phase, {**base, name:'synthetic'}, self.roles))
                    else:
                        with self.assertRaisesRegex(ValueError, 'PHASE_ENV_EXTRA_REFERENCE'):
                            phase_environment(phase, {**base, name:'synthetic'}, self.roles)

    def test_alternate_env_file_reference_refused(self):
        for name in ['PGPASSFILE', 'PGSERVICEFILE', 'PGSERVICE', 'NODE_OPTIONS', 'BASH_ENV', 'ENV']:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'PHASE_ENV_EXTRA_REFERENCE'):
                phase_environment('authoring', {**self.env, name:'/host/secret'}, self.roles)

    def test_mount_root_refused(self):
        with self.assertRaisesRegex(ValueError, 'MOUNT_OVERBROAD'):
            audit_mounts([{'source':'/', 'target':'/', 'mode':'ro'}])

    def test_mounted_secret_file_refused(self):
        (self.root/'innocent.json').write_text('synthetic-admin-secret')
        with self.assertRaisesRegex(ValueError, 'MOUNT_FORBIDDEN_SECRET'):
            audit_mounts([self.mount], ['synthetic-admin-secret'])

    def test_auto_loaded_credentials_refused(self):
        (self.root/'.pgpass').write_text('synthetic')
        with self.assertRaisesRegex(ValueError, 'MOUNT_CREDENTIAL_FILE'):
            audit_mounts([self.mount])

    def test_shipped_env_example_kept_but_still_secret_scanned(self):
        example = self.root/'.env.example'
        example.write_text('DATABASE_URL=postgresql://user:replace-me@localhost/database')
        self.assertEqual(audit_mounts([self.mount])['files_checked'], 1)
        example.write_text('DATABASE_URL=synthetic-admin-secret')
        with self.assertRaisesRegex(ValueError, 'MOUNT_FORBIDDEN_SECRET'):
            audit_mounts([self.mount], ['synthetic-admin-secret'])

    def test_escape_symlink_refused(self):
        (self.root/'outside').symlink_to('/etc/hosts')
        with self.assertRaisesRegex(ValueError, 'MOUNT_SYMLINK_ESCAPE'):
            audit_mounts([self.mount])

    def test_host_socket_refused(self):
        with socket.socket(socket.AF_UNIX) as sock:
            sock.bind(str(self.root/'socket'))
            with self.assertRaisesRegex(ValueError, 'MOUNT_IPC_FORBIDDEN'):
                audit_mounts([self.mount])

    def test_scoped_mount_accepted_and_ipc_isolated(self):
        (self.root/'config.json').write_text('{"read_url_env":"DATABASE_URL"}')
        self.assertEqual(audit_mounts([self.mount])['files_checked'], 1)
        args = bubblewrap_args([self.mount])
        self.assertIn('--unshare-ipc', args)
        self.assertNotIn('/', args)
        self.assertIn('/owned', args)
        self.assertIn('/var/tmp', args)

    def snapshot(self):
        dbpath = self.root/'owned.db'
        with sqlite3.connect(dbpath) as db:
            db.execute('create table t0(id integer primary key autoincrement, value blob)')
            db.execute('insert into t0(value) values (?)', (b'one',))
            for i in range(1,41):
                db.execute(f'create table t{i}(id integer primary key, value text)')
        (self.root/'config.json').write_text('{"mode":"source_db"}')
        source = {'public.rows': {'columns':['id','value'], 'rows':[[1,'one'],[2,'two']]},
                  'public.receipts': {'columns':['result_hash'], 'rows':[['exact-hash']]}}
        return logical_snapshot(dbpath, self.root, ['config.json'], source)

    def test_full_table_inventory_and_no_change(self):
        snap = self.snapshot()
        self.assertEqual(len(snap['control']), 42)
        self.assertIn('sqlite_sequence', snap['control'])
        self.assertEqual(compare_snapshots(snap, copy.deepcopy(snap)), [])

    def test_same_count_mutation_detected(self):
        before = self.snapshot(); after = copy.deepcopy(before)
        after['control']['t0']['rows'][0][1] = {'sqlite_blob_hex':'74776f'}
        diff = compare_snapshots(before, after)
        self.assertEqual(len(diff), 1)
        self.assertEqual(len(diff[0]['removed_rows']), 1)
        self.assertEqual(len(diff[0]['added_rows']), 1)

    def test_missing_table_detected(self):
        before = self.snapshot(); after = copy.deepcopy(before)
        del after['control']['t40']
        self.assertEqual(compare_snapshots(before, after)[0]['name'], 't40')

    def test_same_count_source_change_and_config_detected(self):
        before = self.snapshot(); after = copy.deepcopy(before)
        after['source']['public.rows']['rows'][0][1] = 'changed'
        after['config']['config.json']['sha256'] = 'changed'
        self.assertEqual({d['domain'] for d in compare_snapshots(before, after)}, {'config','source'})

    def test_config_inventory_detects_new_file_and_retains_link(self):
        (self.root/'resume.json').write_text('{}')
        before = config_tree_snapshot(self.root)
        (self.root/'new-policy.json').write_text('{}')
        (self.root/'link').symlink_to('resume.json')
        after = config_tree_snapshot(self.root)
        self.assertEqual(set(after)-set(before), {'new-policy.json','link'})
        self.assertEqual(after['link']['target'], 'resume.json')

    def test_duplicate_row_multiplicity_detected(self):
        before = self.snapshot(); after = copy.deepcopy(before)
        after['source']['public.rows']['rows'] = [[1,'one'],[1,'one']]
        diff = compare_snapshots(before, after)[0]
        self.assertEqual(len(diff['added_rows']), 1)

    def test_receipt_serialization_not_conflated(self):
        basis = {'z':1, 'a':2}; reordered = {'a':2, 'z':1}
        self.assertNotEqual(receipt_hash(basis, control=False), receipt_hash(reordered, control=False))
        self.assertEqual(receipt_hash(basis, control=True), receipt_hash(reordered, control=True))

    def observations(self):
        proc={'pid':123,'start_token':'owned-start','session_id':'owned-session'}
        return proc,[{'kind':k,'process':proc,'completed':True,'isError':False,
                      'response_sha256':'synthetic-response-digest'} for k in ['listing','detail','read']]

    def test_publication_requires_all_actual_observations(self):
        proc, obs = self.observations()
        self.assertTrue(require_prepublication_observations(proc, obs, alive=True))
        for missing in ['listing','detail','read']:
            with self.assertRaisesRegex(ValueError, 'PREPUBLICATION_OBSERVATION_MISSING'):
                require_prepublication_observations(proc, [o for o in obs if o['kind']!=missing], alive=True)

    def test_restarted_or_dead_process_not_continuity(self):
        proc, obs = self.observations()
        with self.assertRaisesRegex(ValueError, 'PERSISTENT_PROCESS_NOT_ALIVE'):
            require_prepublication_observations(proc, obs, alive=False)
        with self.assertRaisesRegex(ValueError, 'PREPUBLICATION_OBSERVATION_MISSING'):
            require_prepublication_observations({**proc,'start_token':'restarted'}, obs, alive=True)

    def test_controller_derives_real_protocol_pairs_before_deadline(self):
        proc, _ = self.observations()
        at='2026-09-22T01:00:00Z'
        records=[]
        def pair(i, method, params, result):
            records.extend([{'at':at,'kind':'request','body':{'id':i,'method':method,'params':params}},
                            {'at':at,'kind':'response','body':{'id':i,'result':result}}])
        pair(1,'initialize',{}, {'protocolVersion':'2025-03-26'})
        for i,(tool,args) in enumerate([('app.describe_actions',{}),
                                       ('app.describe_actions',{'outcome':'synthetic.outcome'}),
                                       ('app.explore_data',{'plan':{'kind':'rows'}})],2):
            pair(i,'tools/call',{'name':tool,'arguments':args},{'structuredContent':{'ok':True}})
        self.assertEqual(len(prepublication_capture_gate(proc,records,proposed_at='2026-09-22T01:01:00Z',alive=True)),3)
        with self.assertRaisesRegex(ValueError,'PREPUBLICATION_OBSERVATION_MISSING'):
            prepublication_capture_gate(proc,records,proposed_at='2026-09-22T00:59:00Z',alive=True)
        records[-1]['body']['result']['isError']=True
        with self.assertRaisesRegex(ValueError,'PREPUBLICATION_OBSERVATION_MISSING_READ'):
            prepublication_capture_gate(proc,records,proposed_at='2026-09-22T01:01:00Z',alive=True)

    def test_replay_schedule_reserves_real_lifetime(self):
        params={'now':'2026-09-22T01:00:00Z','expires_at':'2026-09-22T01:05:00Z'}
        self.assertEqual(require_replay_time(**params, operation_bound_seconds=240), 300)
        with self.assertRaisesRegex(ValueError, 'REFERENCE_LIFETIME_INSUFFICIENT'):
            require_replay_time(**params, operation_bound_seconds=285)
        with self.assertRaisesRegex(ValueError, 'REFERENCE_LIFETIME_INSUFFICIENT'):
            require_replay_time(now='2026-09-22T01:06:00Z', expires_at=params['expires_at'], operation_bound_seconds=1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
