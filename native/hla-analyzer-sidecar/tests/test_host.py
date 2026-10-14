import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from fractions import Fraction

sys.dont_write_bytecode = True
HOST = Path(__file__).resolve().parents[1]
ROOT = HOST.parents[1]
sys.path.insert(0, str(HOST))
from saleae.data import GraphTime, GraphTimeDelta
from saleae.analyzers import HighLevelAnalyzer, StringSetting, NumberSetting, ChoicesSetting, configured_instance, settings_for
from main import decode_value, encode_value, validate_template, render, AnalyzerFrame

MANIFEST = ROOT / 'testdata/hla/original/extension.json'


def initial(cls='Counter', op='start', settings=None, **kwargs):
    return dict(op=op, manifest_path=str(MANIFEST), entry_point='fixture.' + cls,
                settings={} if settings is None else settings, sample_rate_hz=1000000, **kwargs)


def frame(kind='x', start=0, end=1, data=None):
    return dict(type=kind, start_sample=start, end_sample=end, data={} if data is None else data)


def run(requests, raw=None):
    wire = raw if raw is not None else ''.join(json.dumps(r) + '\n' for r in requests)
    result = subprocess.run([sys.executable, '-I', str(HOST / 'main.py')], input=wire,
                            capture_output=True, text=True, timeout=15,
                            env=dict(os.environ, PYTHONPATH='/does/not/exist'))
    return result.returncode, [json.loads(line) for line in result.stdout.splitlines()], result.stderr


class ProtocolTests(unittest.TestCase):
    def success(self, requests):
        code, responses, stderr = run(requests + [{'op': 'finish'}])
        self.assertEqual(code, 0, responses)
        self.assertEqual(responses[-1], {'done': True})
        return responses, stderr

    def test_inspect_inherited_schema_no_init(self):
        responses, stderr = self.success([initial(op='inspect')])
        schema = {s['id']: s for s in responses[0]['settings']}
        self.assertEqual(schema['label'], {'id': 'label', 'kind': 'string', 'default': 'child'})
        self.assertEqual(schema['step'], {'id': 'step', 'kind': 'number', 'default': 2, 'min': 1, 'max': 10})
        self.assertEqual(schema['mode']['choices'], ['one', 'two'])
        self.assertIn('count', responses[0]['result_types'])
        self.assertNotIn('initialized', stderr)

    def test_state_override_before_init_and_print_hygiene(self):
        requests = [initial(settings={'step': 3, 'label': 'override', 'mode': 'two'}),
                    {'op': 'batch', 'frames': [frame()]}, {'op': 'batch', 'frames': [frame(start=1, end=2)]}]
        responses, stderr = self.success(requests)
        self.assertEqual(responses[0], {'ready': True})
        self.assertEqual(responses[1]['frames'][0]['text'], 'count local:override 3')
        self.assertEqual(responses[2]['frames'][0]['data']['count'], {'Signed': 6})
        self.assertIn('fixture imported', stderr)
        self.assertIn('fixture initialized', stderr)
        self.assertEqual(stderr.count('fixture decoded'), 2)
        again, _ = self.success(requests)
        self.assertEqual(responses, again)

    def test_defaults(self):
        responses, _ = self.success([initial(), {'op': 'batch', 'frames': [frame()]}])
        self.assertEqual(responses[1]['frames'][0]['text'], 'count local:child 2')

    def test_batching_equivalence(self):
        frames = [frame(start=i, end=i+1) for i in range(17)]
        whole, _ = self.success([initial(), {'op': 'batch', 'frames': frames}])
        split, _ = self.success([initial()] + [{'op': 'batch', 'frames': frames[i:i+3]} for i in range(0, 17, 3)])
        self.assertEqual(whole[1]['frames'], [f for r in split[1:-1] for f in r['frames']])

    def test_variants_and_fallback(self):
        responses, _ = self.success([initial('Variants'), {'op': 'batch', 'frames':
                                    [frame('none'), frame('single'), frame('list'), frame('empty')]}])
        output = responses[1]['frames']
        self.assertEqual([f['text'] for f in output], ['single', 'list', 'list'])

    def test_nested_tagged_roundtrip(self):
        data = {'nested': {'Map': {'values': {'List': [
            {'Text': 'é\n'}, {'Signed': -2**63}, {'Signed': 7}, {'Unsigned': 7},
            {'Unsigned': 2**64-1}, {'Float': 1.25}, {'Boolean': True},
            {'Bytes': [0, 255]}, {'Null': None}]}}}}
        responses, _ = self.success([initial('Echo'), {'op': 'batch', 'frames': [frame(data=data)]}])
        self.assertEqual(responses[1]['frames'][0]['data'], data)

    def test_long_origin_precision(self):
        start = 2**64 - 2
        origin = {'numerator': 2**63-1, 'denominator': 7}
        responses, _ = self.success([initial('Echo', time_origin=origin),
                                    {'op': 'batch', 'frames': [frame(start=start, end=start+1)]}])
        self.assertEqual(responses[1]['frames'][0]['start_sample'], start)
        self.assertEqual(responses[1]['frames'][0]['end_sample'], start+1)

    def test_invalid_settings(self):
        for settings in ({'unknown': 1}, {'label': 1}, {'mode': 'bad'}, {'step': 0},
                         {'step': 11}, {'step': True}, {'step': float('nan')}, {'step': float('inf')}):
            for op in ('start', 'inspect'):
                with self.subTest(settings=settings, op=op):
                    code, responses, _ = run([initial(op=op, settings=settings)])
                    self.assertNotEqual(code, 0)
                    self.assertIn('error', responses[0])

    def test_manifest_checked_before_import(self):
        for cls in ('NotHLA', 'Missing'):
            code, responses, stderr = run([initial(cls, op='inspect')])
            self.assertNotEqual(code, 0)
            self.assertIn('manifest feature', responses[0]['error'])
            self.assertNotIn('fixture imported', stderr)

    def test_template_rejected_inspect_and_start(self):
        for op in ('inspect', 'start'):
            code, responses, _ = run([initial('BadTemplate', op=op)])
            self.assertNotEqual(code, 0)
            self.assertIn('template', responses[0]['error'])

    def test_plugin_errors(self):
        for cls, error in [('OffGrid', 'off the sample grid'), ('Negative', 'output sample'),
                           ('BadReturn', 'decode must return'), ('Raises', 'fixture decode error')]:
            with self.subTest(cls=cls):
                code, responses, _ = run([initial(cls), {'op': 'batch', 'frames': [frame()]}])
                self.assertNotEqual(code, 0)
                self.assertEqual(responses[0], {'ready': True})
                self.assertIn(error, responses[1]['error'])

    def test_input_errors(self):
        for raw in (frame(start=-1), frame(end=2**64), frame(start=True), frame(start=2, end=1),
                    frame(data={'x': {'Bytes': [256]}}), frame(data={'x': {'Unsigned': -1}}),
                    frame(data={'x': {'Signed': 2**63}}), frame(data={'x': {'Float': float('inf')}}),
                    frame(data={'x': {'Null': False}}), frame(data={'x': {'Unknown': 1}})):
            code, responses, _ = run([initial('Echo'), {'op': 'batch', 'frames': [raw]}])
            self.assertNotEqual(code, 0)
            self.assertIn('error', responses[-1])
        for field, value in [('sample_rate_hz', 0), ('sample_rate_hz', 2**64),
                             ('time_origin', {'numerator': 0, 'denominator': 0})]:
            first = initial()
            first[field] = value
            code, responses, _ = run([first])
            self.assertNotEqual(code, 0)
            self.assertIn('error', responses[-1])
        code, responses, _ = run([], raw='not json\n')
        self.assertNotEqual(code, 0)
        self.assertIn('error', responses[0])
        code, responses, _ = run([initial('Echo')])
        self.assertNotEqual(code, 0)
        self.assertIn('EOF', responses[-1]['error'])

    def test_inspect_batch_invalid_and_unknown_operation(self):
        for first, next_request in [(initial(op='inspect'), {'op': 'batch', 'frames': []}),
                                    (initial(), {'op': 'unknown'})]:
            code, responses, _ = run([first, next_request])
            self.assertNotEqual(code, 0)
            self.assertIn('error', responses[-1])


    def test_legacy_new_receives_settings_mapping(self):
        responses, _ = self.success([initial('Legacy', settings={'label': 'x'}),
                                     {'op': 'batch', 'frames': [frame()]}])
        output = responses[-2]['frames'][0]
        self.assertEqual(output['data']['label'], {'Text': 'x!'})
        self.assertEqual(output['text'], 'legacy')
        defaults, _ = self.success([initial('Legacy'), {'op': 'batch', 'frames': [frame()]}])
        self.assertEqual(defaults[-2]['frames'][0]['data']['label'], {'Text': 'base!'})


class ShimTests(unittest.TestCase):
    def test_time_arithmetic(self):
        t = GraphTime(Fraction(2**63-1, 7))
        delta = GraphTimeDelta(0, 1)
        self.assertEqual((t + delta) - t, delta)
        self.assertEqual((t + delta) - delta, t)
        self.assertEqual(delta + t, t + delta)
        self.assertGreater(t + delta, t)
        self.assertTrue(t <= t)
        self.assertEqual(delta * 2 / 2, delta)
        self.assertEqual(delta / delta, 1)
        self.assertEqual(-(-delta), delta)
        self.assertEqual(abs(-delta), delta)
        self.assertEqual(GraphTimeDelta(milliseconds=1, nanoseconds=1).fraction, Fraction(1000001, 10**9))
        self.assertEqual(GraphTime(0.1).fraction, Fraction(1, 10))
        self.assertEqual(float(GraphTime('0.125')), 0.125)
        self.assertEqual(float(str(GraphTimeDelta('0.125'))), 0.125)
        with self.assertRaises(ValueError):
            GraphTime(float('nan'))

    def test_public_time_constructor_and_utc(self):
        from datetime import datetime, timezone, timedelta
        utc = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
        t = GraphTime(utc, 2, microsecond=3, nanosecond=4, picosecond=5)
        self.assertEqual(str(t), '2026-01-02T03:04:05.002003004005Z')
        self.assertEqual(t.as_datetime(), utc + timedelta(milliseconds=2, microseconds=3))
        delta = GraphTimeDelta(second=1, millisecond=2, microsecond=3, nanosecond=4, picosecond=5)
        self.assertEqual(delta.fraction, Fraction(1002003004005, 10**12))
        self.assertEqual(GraphTime(utc.astimezone(timezone(timedelta(hours=8)))), GraphTime(utc))
        self.assertEqual(GraphTimeDelta(0, 1).fraction, Fraction(1, 1000))

    def test_number_defaults_are_inside_declared_bounds(self):
        self.assertEqual(NumberSetting(min_value=1).schema('x')['default'], 1)
        self.assertEqual(NumberSetting(max_value=-1).schema('x')['default'], -1)
        self.assertEqual(NumberSetting(min_value=-1, max_value=1).schema('x')['default'], 0)
        with self.assertRaises(ValueError):
            NumberSetting(min_value=1, default=0).schema('x')

    def test_templates(self):
        for text in ('{{helper data.x}}', '{{#each data.x}}{{/each}}', '{{{data.x}}}', '{{unknown}}', '{{data.x', '{{!comment}}'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                validate_template(text)
        validate_template('{{ type }} {{data.nested.x}}')
        f = AnalyzerFrame('x', GraphTime(), GraphTime(), {'nested': {'x': True}})
        self.assertEqual(render(f, {'x': '{{ type }} {{data.nested.x}}'}), 'x true')
        self.assertEqual(render(f, {'x': ''}), '')
        with self.assertRaises(ValueError):
            render(f, {'x': '{{data.missing}}'})

    def test_setting_shadow_and_instance_isolation(self):
        class Base(HighLevelAnalyzer):
            a = StringSetting(default='a')
            b = NumberSetting(default=2)
        class Child(Base):
            b = 'not a setting'
            def __init__(self):
                self.seen = self.a
        self.assertEqual(list(settings_for(Child)), ['a'])
        first = configured_instance(Child, {'a': 'custom'})
        second = configured_instance(Child, {})
        self.assertEqual(first.seen, 'custom')
        self.assertEqual(second.seen, 'a')
        self.assertEqual(Child.a.default, 'a')

    def test_output_validation_and_descriptor_bounds(self):
        for value in (2**64, -(2**63)-1, float('nan'), float('inf'), {1: 'x'}, object()):
            with self.subTest(value=value), self.assertRaises(ValueError):
                encode_value(value)
        for kwargs in ({'min_value': float('inf')}, {'min_value': 2, 'max_value': 1}):
            with self.assertRaises(ValueError):
                NumberSetting(**kwargs)
        with self.assertRaises(ValueError):
            ChoicesSetting([])
        for value in ({}, {'Text': 1}, {'Boolean': 1}, {'Signed': True}):
            with self.assertRaises(ValueError):
                decode_value(value)

    def test_output_sample_limits(self):
        from main import Session
        session = Session.__new__(Session)
        session.origin, session.rate = Fraction(0), 1
        self.assertEqual(session.sample(GraphTime(2**64-1)), 2**64-1)
        for time in (GraphTime(-1), GraphTime(2**64), GraphTime(Fraction(1, 3)), 0.0):
            with self.subTest(time=time), self.assertRaises(ValueError):
                session.sample(time)



    def test_legacy_new_convention_and_validation(self):
        class Legacy(HighLevelAnalyzer):
            label = StringSetting(default='base')

            def __new__(cls, settings, *args, **kwargs):
                compatible = dict(settings)
                compatible['label'] = compatible.get('label', '') + '!'
                return super().__new__(cls, compatible, *args, **kwargs)

            def __init__(self):
                self.seen = self.label

        self.assertEqual(configured_instance(Legacy, {'label': 'x'}).seen, 'x!')
        self.assertEqual(configured_instance(Legacy, {}).seen, 'base!')
        with self.assertRaises(ValueError):
            configured_instance(Legacy, {'label': 1})
        with self.assertRaises(ValueError):
            configured_instance(Legacy, {'unknown': 1})
if __name__ == '__main__':
    unittest.main()
