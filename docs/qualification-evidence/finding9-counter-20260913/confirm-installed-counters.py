"""Prompt-checked installed terminal submission; never edits stored authority."""
from pathlib import Path
import pexpect,sys,json
repo=Path(__file__).resolve().parents[3];owned=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/finding9-counter-454a0d2-20260913');label=sys.argv[1];draft=sys.argv[2] if len(sys.argv)>2 else 'action.json';assert '/' not in label
command=['python3',str(repo/'docs/qualification-evidence/finding9-counter-20260913/launch-installed.py'),'start','--project-root','.','--draft',draft,'--review-counters','--json']
child=pexpect.spawn(command[0],command[1:],cwd=repo,encoding='utf-8',timeout=30,dimensions=(40,130));log=(owned/'logs'/f'{label}.pty.log').open('x');child.logfile=log
try:
 for resource,options in [('public.dock_slots',['rev_no']),('public.shipments',['rev_no','weight_kg'])]:
  child.expect_exact('SELECT MAINTAINED CONFLICT COUNTER');child.expect_exact('Esc Back');screen=child.before
  assert f'UPDATE target: {resource}.' in screen,screen
  assert 'Cancel this draft submission' in screen and all(option in screen for option in options),screen
  # No current option is selected: the displayed second option is rev_no.
  child.send('\x1b[B\x1b[B\r')
  child.expect_exact('REVIEW CHANGED-RECORD PROTECTION');child.expect_exact('Esc Back');screen=child.before
  assert f'Use {resource}.rev_no' in screen and 'every source writer increments' in screen,screen
  assert 'Confirm this maintained counter' in screen and 'Keep this mapping pending' in screen
  child.send('\x1b[B\r')
 child.expect(pexpect.EOF);result=child.before;child.close();print(result);print('EXIT',child.exitstatus)
 (owned/'logs'/f'{label}.exit.json').write_text(json.dumps({'exit_code':child.exitstatus,'args':command[2:],'confirmed':[{'resource':r,'field':'rev_no','contract':'all_writers_increment'} for r in ['public.dock_slots','public.shipments']]},indent=2)+'\n')
 if child.exitstatus:raise SystemExit(child.exitstatus)
finally:
 if child.isalive():child.terminate(force=True)
 log.close()
