"""Original MIT-licensed fixture; no vendor source used."""
from fractions import Fraction
from saleae.analyzers import HighLevelAnalyzer, AnalyzerFrame, StringSetting, NumberSetting, ChoicesSetting
from saleae.data import GraphTimeDelta
from auxiliary import PREFIX

print('fixture imported')


class Base(HighLevelAnalyzer):
    label = StringSetting(default='base')
    step = NumberSetting(min_value=1, max_value=10, default=2)
    mode = ChoicesSetting(['one', 'two'])


class Counter(Base):
    label = StringSetting(default='child')
    result_types = {'count': {'format': '{{type}} {{data.meta.label}} {{data.count}}'}}

    def __init__(self):
        print('fixture initialized')
        self.initial_label = PREFIX + ':' + self.label
        self.count = self.step

    def decode(self, frame):
        print('fixture decoded')
        result = AnalyzerFrame('count', frame.start_time, frame.end_time,
                               {'count': self.count, 'meta': {'label': self.initial_label}})
        self.count += self.step
        return result


class Echo(HighLevelAnalyzer):
    def decode(self, frame):
        return frame


class Variants(HighLevelAnalyzer):
    def decode(self, frame):
        if frame.type == 'none':
            return None
        if frame.type == 'list':
            return [frame, frame]
        if frame.type == 'empty':
            return []
        return frame


class BadTemplate(Echo):
    result_types = {'x': {'format': '{{#if data.x}}x{{/if}}'}}


class OffGrid(Echo):
    def decode(self, frame):
        frame.end_time += GraphTimeDelta(Fraction(1, 3))
        return frame


class Negative(Echo):
    def decode(self, frame):
        frame.start_time -= GraphTimeDelta(100)
        return frame


class BadReturn(Echo):
    def decode(self, frame):
        return 'invalid'


class Raises(Echo):
    def decode(self, frame):
        raise RuntimeError('fixture decode error')


class NotHLA:
    pass


class Legacy(HighLevelAnalyzer):
    """Saleae's older convention: the settings mapping is passed to __new__."""

    label = StringSetting(default='base')

    def __new__(cls, settings, *args, **kwargs):
        compatible = dict(settings)
        compatible['label'] = compatible.get('label', '') + '!'
        return super().__new__(cls, compatible, *args, **kwargs)

    def __init__(self):
        self.seen = self.label

    def decode(self, frame):
        return AnalyzerFrame('legacy', frame.start_time, frame.end_time, {'label': self.seen})
