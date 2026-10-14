#!/usr/bin/env python3
"""Trusted-extension JSON-lines host. Launch with python3 -I main.py."""
import sys
from pathlib import Path
import sysconfig

# -I removes the script directory as well as ambient site/user paths.
HOST = Path(__file__).resolve().parent
stdlib_roots = {Path(sysconfig.get_path(key)).resolve() for key in ('stdlib', 'platstdlib')}
sys.path[:] = [str(HOST)] + [p for p in sys.path if p and
    (Path(p).resolve() in stdlib_roots or Path(p).name == 'lib-dynload'
     or (Path(p).suffix == '.zip' and Path(p).parent.resolve() in {r.parent for r in stdlib_roots}))]
sys.dont_write_bytecode = True

import importlib
import json
import math
import re
from fractions import Fraction
from saleae.analyzers import AnalyzerFrame, HighLevelAnalyzer, configured_instance, settings_for
from saleae.data import GraphTime

U64 = 2**64 - 1
I64_MIN, I64_MAX = -(2**63), 2**63 - 1


class Signed(int):
    pass


class Unsigned(int):
    pass


def integer(value, low, high, name):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f'{name}: integer outside [{low}, {high}]')
    return value


def object_value(value, name):
    if not isinstance(value, dict):
        raise ValueError(f'{name}: expected object')
    return value


def decode_value(value):
    if not isinstance(value, dict) or len(value) != 1:
        raise ValueError('value must have exactly one tag')
    tag, item = next(iter(value.items()))
    if tag == 'Text' and isinstance(item, str):
        return item
    if tag == 'Signed':
        return Signed(integer(item, I64_MIN, I64_MAX, tag))
    if tag == 'Unsigned':
        return Unsigned(integer(item, 0, U64, tag))
    if tag == 'Float' and type(item) in (float, int) and math.isfinite(item):
        return float(item)
    if tag == 'Boolean' and type(item) is bool:
        return item
    if tag == 'Null' and item is None:
        return None
    if tag == 'Bytes' and isinstance(item, list):
        return bytes(integer(x, 0, 255, 'byte') for x in item)
    if tag == 'List' and isinstance(item, list):
        return [decode_value(x) for x in item]
    if tag == 'Map' and isinstance(item, dict):
        return {k: decode_value(v) for k, v in item.items()}
    raise ValueError(f'invalid tagged value: {tag}')


def encode_value(value):
    if value is None:
        return {'Null': None}
    if isinstance(value, bool):
        return {'Boolean': value}
    if isinstance(value, str):
        return {'Text': value}
    if isinstance(value, int):
        tag = 'Unsigned' if isinstance(value, Unsigned) or (not isinstance(value, Signed) and value > I64_MAX) else 'Signed'
        low, high = (0, U64) if tag == 'Unsigned' else (I64_MIN, I64_MAX)
        integer(int(value), low, high, tag)
        return {tag: int(value)}
    if isinstance(value, float) and math.isfinite(value):
        return {'Float': value}
    if isinstance(value, (bytes, bytearray)):
        return {'Bytes': list(value)}
    if isinstance(value, list):
        return {'List': [encode_value(x) for x in value]}
    if isinstance(value, dict) and all(isinstance(k, str) for k in value):
        return {'Map': {k: encode_value(v) for k, v in value.items()}}
    raise ValueError(f'unsupported output data value: {type(value).__name__}')


TOKEN = re.compile(r'{{\s*(type|data\.[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*)\s*}}')


def validate_template(template):
    if not isinstance(template, str) or '{{{' in template or '}}}' in template:
        raise ValueError('unsupported result template')
    remainder = TOKEN.sub('', template)
    if '{{' in remainder or '}}' in remainder:
        raise ValueError('unsupported result template expression')


def templates_for(result_types):
    object_value(result_types, 'result_types')
    templates = {}
    for name, spec in result_types.items():
        object_value(spec, 'result type')
        if 'format' in spec:
            validate_template(spec['format'])
            templates[name] = spec['format']
    return templates


def render(frame, templates):
    if frame.type not in templates:
        return frame.type

    def substitute(match):
        path = match.group(1)
        if path == 'type':
            return frame.type
        value = frame.data
        for key in path.split('.')[1:]:
            if not isinstance(value, dict) or key not in value:
                raise ValueError(f'missing template field: {path}')
            value = value[key]
        if value is None:
            return ''
        if isinstance(value, bool):
            return 'true' if value else 'false'
        return str(value)

    return TOKEN.sub(substitute, templates[frame.type])


def load_analyzer(request):
    manifest_name = request.get('manifest_path')
    entry = request.get('entry_point')
    if not isinstance(manifest_name, str) or not isinstance(entry, str):
        raise ValueError('manifest_path and entry_point must be strings')
    manifest = Path(manifest_name).resolve(strict=True)
    document = object_value(json.loads(manifest.read_text(encoding='utf-8')), 'manifest')
    extensions = object_value(document.get('extensions'), 'manifest extensions')
    matches = [spec for spec in extensions.values()
               if isinstance(spec, dict) and spec.get('entryPoint') == entry
               and spec.get('type') == 'HighLevelAnalyzer']
    if not matches:
        raise ValueError('entry point does not match a HighLevelAnalyzer manifest feature')
    if not re.fullmatch(r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+', entry, flags=re.ASCII):
        raise ValueError('entry_point must be module.Class')
    module_name, class_name = entry.rsplit('.', 1)
    root = manifest.parent
    module_file = root.joinpath(*module_name.split('.')).with_suffix('.py')
    package_file = root.joinpath(*module_name.split('.'), '__init__.py')
    target = module_file if module_file.is_file() else package_file
    if not target.is_file() or not target.resolve().is_relative_to(root):
        raise ValueError('entry module must be inside the extension directory')
    # Host wins over a local saleae namespace; local auxiliary modules follow it.
    sys.path.insert(1, str(root))
    module = importlib.import_module(module_name)
    if not getattr(module, '__file__', None) or Path(module.__file__).resolve() != target.resolve():
        raise ValueError('entry module resolved outside the requested extension')
    cls = getattr(module, class_name)
    if not isinstance(cls, type) or not issubclass(cls, HighLevelAnalyzer):
        raise ValueError('entry point must be a HighLevelAnalyzer subclass')
    return cls


class Session:
    def __init__(self, request):
        if request.get('op') not in ('inspect', 'start'):
            raise ValueError('first operation must be inspect or start')
        self.rate = integer(request.get('sample_rate_hz'), 1, U64, 'sample_rate_hz')
        origin = object_value(request.get('time_origin', {'numerator': 0, 'denominator': 1}), 'time_origin')
        self.origin = Fraction(integer(origin.get('numerator'), I64_MIN, I64_MAX, 'origin numerator'),
                               integer(origin.get('denominator'), 1, U64, 'origin denominator'))
        settings = object_value(request.get('settings'), 'settings')
        self.cls = load_analyzer(request)
        self.schemas = [descriptor.schema(name) for name, descriptor in settings_for(self.cls).items()]
        self.templates = templates_for(self.cls.result_types)
        descriptors = settings_for(self.cls)
        if settings.keys() - descriptors.keys():
            raise ValueError('unknown settings')
        for name, value in settings.items():
            descriptors[name].validate(value)
        self.instance = configured_instance(self.cls, settings) if request['op'] == 'start' else None
        if self.instance is not None:
            self.templates = templates_for(self.instance.result_types)

    def sample(self, time):
        if not isinstance(time, GraphTime):
            raise ValueError('output time must be GraphTime')
        value = (time.fraction - self.origin) * self.rate
        if value.denominator != 1:
            raise ValueError('output time is off the sample grid')
        return integer(value.numerator, 0, U64, 'output sample')

    def batch(self, request):
        if self.instance is None:
            raise ValueError('inspect cannot process batches')
        frames = request.get('frames')
        if not isinstance(frames, list):
            raise ValueError('frames must be a list')
        output = []
        for raw in frames:
            object_value(raw, 'frame')
            start = integer(raw.get('start_sample'), 0, U64, 'start_sample')
            end = integer(raw.get('end_sample'), 0, U64, 'end_sample')
            if end < start:
                raise ValueError('frame end precedes start')
            data = {k: decode_value(v) for k, v in object_value(raw.get('data'), 'data').items()}
            frame = AnalyzerFrame(raw.get('type'), GraphTime(self.origin + Fraction(start, self.rate)),
                                  GraphTime(self.origin + Fraction(end, self.rate)), data)
            result = self.instance.decode(frame)
            results = [] if result is None else result if isinstance(result, list) else [result]
            for item in results:
                if not isinstance(item, AnalyzerFrame):
                    raise ValueError('decode must return None, AnalyzerFrame, or a list of frames')
                if not isinstance(item.type, str):
                    raise ValueError('output type must be a string')
                first, last = self.sample(item.start_time), self.sample(item.end_time)
                if last < first:
                    raise ValueError('output end precedes start')
                tagged = {k: encode_value(v) for k, v in object_value(item.data, 'output data').items()}
                if any(not isinstance(k, str) for k in tagged):
                    raise ValueError('output data keys must be strings')
                output.append({'type': item.type, 'start_sample': first, 'end_sample': last,
                               'data': tagged, 'text': render(item, self.templates)})
        return {'frames': output}


def parse(line):
    def bad_constant(value):
        raise ValueError(f'nonfinite JSON number: {value}')
    return object_value(json.loads(line, parse_constant=bad_constant), 'request')


def main():
    protocol_out, protocol_in = sys.stdout, sys.stdin
    # Ordinary plugin prints, including import-time prints, never reach the wire.
    sys.stdout = sys.stderr

    def respond(value):
        protocol_out.write(json.dumps(value, allow_nan=False, separators=(',', ':')) + '\n')
        protocol_out.flush()

    try:
        line = protocol_in.readline()
        if not line:
            raise ValueError('missing initial request')
        request = parse(line)
        session = Session(request)
        respond({'ready': True} if request['op'] == 'start' else
                {'settings': session.schemas, 'result_types': session.cls.result_types})
        for line in protocol_in:
            request = parse(line)
            if request.get('op') == 'finish':
                respond({'done': True})
                return 0
            if request.get('op') != 'batch':
                raise ValueError('expected batch or finish')
            respond(session.batch(request))
        raise ValueError('unexpected EOF before finish')
    except BaseException as error:
        respond({'error': f'{type(error).__name__}: {error}'})
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
