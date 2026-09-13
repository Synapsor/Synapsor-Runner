"""Read existing captures only; a model submission is not a committed decision."""
from pathlib import Path
import hashlib
import json

E = Path(__file__).resolve().parent
O = Path(json.loads((E / 'assignment-plan.json').read_text())['owned_root'])
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
records = []
for run in sorted((O / 'runs').iterdir()):
    inputs = sorted((run / 'meter').glob('input-*.json'))
    later = [json.loads(p.read_text())['request'].get('input', []) for p in inputs]
    calls = []
    previous_coverage = None
    for offset, p in enumerate(inputs):
        n = int(p.stem.split('-')[-1])
        out = p.with_name(f'output-{n:04d}.txt')
        response = None
        if out.exists():
            for line in out.read_text().splitlines():
                if not line.startswith('data: '):
                    continue
                try:
                    event = json.loads(line[6:])
                except json.JSONDecodeError:
                    continue
                if event.get('type') == 'response.completed':
                    response = event['response']
        functions = [x for x in (response or {}).get('output', []) if x.get('type') == 'function_call']
        names = [x['name'] for x in functions]
        purposes, observations, coverage = [], [], []
        for f in functions:
            name = f['name']
            if 'policy' in name and ('coverage' in name or 'interpret' in name):
                purposes.append('attached-policy interpretation/recheck')
            elif 'read_workload' in name:
                purposes.append('Read draft preparation')
            elif 'plan_boundary' in name:
                purposes.append('job planning')
            elif 'relationship' in name:
                purposes.append('relationship inspection or explicit review preparation')
            elif 'version' in name or 'counter' in name:
                purposes.append('maintained-counter review preparation')
            elif 'action' in name:
                purposes.append('Action draft/revision preparation')
            else:
                purposes.append('authoring tool step')
            try:
                arguments = json.loads(f.get('arguments', '{}'))
            except json.JSONDecodeError:
                arguments = {}
            for passage in arguments.get('passages', []):
                coverage.append({k: passage[k] for k in ['start', 'end', 'topic', 'disposition', 'responsibility', 'deployment_prerequisite'] if k in passage})
            found = []
            for later_input in later[offset + 1:]:
                if not isinstance(later_input, list):
                    continue
                for item in later_input:
                    if isinstance(item, dict) and item.get('type') == 'function_call_output' and item.get('call_id') == f.get('call_id'):
                        raw = item.get('output', '')
                        try:
                            result = json.loads(raw) if isinstance(raw, str) else raw
                        except json.JSONDecodeError:
                            result = {}
                        found.append({k: result[k] for k in ['ok', 'status', 'code'] if isinstance(result, dict) and k in result})
                if found:
                    break
            observations.append({'tool': name, 'host_result_observed_later': bool(found), 'host_result_summary': found[:1]})
        if not response:
            progress = 'No complete response; preserve transport error/cancelled response. No successful decision inferred.'
        elif coverage:
            progress = 'Submitted clause classifications; acceptance and persistence require the stored review/CLI evidence.'
        elif functions:
            progress = 'Prepared or inspected authoring material. Submission alone proves no activation, approval or source effect.'
        else:
            progress = 'Narration or business clarification; successful transport alone establishes no durable semantic progress.'
        calls.append({'call': n, 'purpose': sorted(set(purposes)) or ['narration/business question' if response else 'incomplete transport'],
                      'tools': names, 'input_sha256': sha(p), 'output_sha256': sha(out) if out.exists() else None,
                      'complete_response': bool(response), 'coverage_topics': coverage,
                      'repeats_previous_coverage_topics': coverage == previous_coverage if coverage and previous_coverage else None,
                      'observed_host_results': observations, 'semantic_progress_limit': progress})
        if coverage:
            previous_coverage = coverage
    records.append({'run': run.name, 'calls': calls})
(E / 'repair-call-classification.json').write_text(json.dumps({'classification': 'existing captured repair calls; no new provider requests', 'runs': records}, indent=2) + '\n')
print(json.dumps({r['run']: len(r['calls']) for r in records}))
