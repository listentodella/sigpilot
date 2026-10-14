"""Original subset of the public HLA interface (not a vendor implementation)."""
import copy
import inspect
import math
from .data import GraphTime, GraphTimeDelta


class AnalyzerFrame:
    def __init__(self, type, start_time, end_time, data=None):
        if not isinstance(type, str):
            raise TypeError('frame type must be a string')
        self.type = type
        self.start_time = start_time
        self.end_time = end_time
        self.data = {} if data is None else data


class Setting:
    kind = None

    def __init__(self, *, label=None, description=None, default=None):
        self.label = label
        self.description = description
        self.default = default
        self.name = None

    def __set_name__(self, owner, name):
        self.name = name

    def __get__(self, instance, owner=None):
        if instance is None:
            return self
        return instance.__dict__.get(self.name, self.default)

    def __set__(self, instance, value):
        self.validate(value)
        instance.__dict__[self.name] = value

    def validate(self, value):
        raise TypeError('unsupported setting descriptor')

    def schema(self, name):
        self.validate(self.default)
        return {'id': name, 'kind': self.kind, 'default': self.default}


class StringSetting(Setting):
    kind = 'string'

    def __init__(self, *, default='', **kwargs):
        super().__init__(default=default, **kwargs)

    def validate(self, value):
        if not isinstance(value, str):
            raise ValueError(f'{self.name}: expected string')


class NumberSetting(Setting):
    kind = 'number'

    def __init__(self, *, min_value=None, max_value=None, default=None, **kwargs):
        super().__init__(default=default, **kwargs)
        for bound in (min_value, max_value):
            if bound is not None and (type(bound) not in (int, float) or not math.isfinite(bound)):
                raise ValueError('setting bounds must be finite numbers')
        if min_value is not None and max_value is not None and min_value > max_value:
            raise ValueError('setting minimum exceeds maximum')
        self.min_value, self.max_value = min_value, max_value
        if default is None:
            self.default = max(0, min_value) if min_value is not None else 0
            if max_value is not None:
                self.default = min(self.default, max_value)

    def validate(self, value):
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError(f'{self.name}: expected finite number')
        if self.min_value is not None and value < self.min_value:
            raise ValueError(f'{self.name}: below minimum')
        if self.max_value is not None and value > self.max_value:
            raise ValueError(f'{self.name}: above maximum')

    def schema(self, name):
        result = super().schema(name)
        if self.min_value is not None:
            result['min'] = self.min_value
        if self.max_value is not None:
            result['max'] = self.max_value
        return result


class ChoicesSetting(Setting):
    kind = 'choices'

    def __init__(self, choices, *, default=None, **kwargs):
        if not isinstance(choices, (list, tuple)) or not choices or any(not isinstance(c, str) for c in choices):
            raise ValueError('choices must be a nonempty sequence of strings')
        self.choices = list(choices)
        super().__init__(default=self.choices[0] if default is None else default, **kwargs)

    def validate(self, value):
        if not isinstance(value, str) or value not in self.choices:
            raise ValueError(f'{self.name}: invalid choice')

    def schema(self, name):
        return dict(super().schema(name), choices=self.choices)


def settings_for(cls):
    attributes = {}
    for base in reversed(cls.__mro__):
        attributes.update(vars(base))
    return {name: value for name, value in attributes.items() if isinstance(value, Setting)}


def resolve_settings(cls, settings):
    """Validate a settings mapping and fill in the declared defaults."""
    if not isinstance(settings, dict):
        raise TypeError('settings must be a mapping')
    descriptors = settings_for(cls)
    unknown = settings.keys() - descriptors.keys()
    if unknown:
        raise ValueError('unknown settings: ' + ', '.join(sorted(unknown)))
    resolved = {}
    for name, descriptor in descriptors.items():
        value = copy.deepcopy(settings.get(name, descriptor.default))
        descriptor.validate(value)
        resolved[name] = value
    return resolved


def _new_accepts_settings(cls):
    """True when the extension defines its own __new__ that takes settings.

    Saleae's host passes the settings mapping to __new__, so extensions may
    map or adapt settings before the base class applies them. Classes that do
    not override __new__ keep the plain construction path.
    """
    function = cls.__new__
    if function is object.__new__:
        return False
    try:
        parameters = inspect.signature(function).parameters
    except (TypeError, ValueError):
        return True
    if 'settings' in parameters:
        return True
    for name, parameter in parameters.items():
        if name == 'cls':
            continue
        if parameter.kind in (parameter.POSITIONAL_ONLY, parameter.POSITIONAL_OR_KEYWORD,
                              parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
            return True
    return False


def configured_instance(cls, settings):
    resolved = resolve_settings(cls, settings)
    instance = cls.__new__(cls, resolved) if _new_accepts_settings(cls) else cls.__new__(cls)
    if not isinstance(instance, cls):
        raise TypeError('analyzer __new__ must return an analyzer instance')
    for name, value in resolved.items():
        if name not in instance.__dict__:
            instance.__dict__[name] = value
    cls.__init__(instance)
    return instance


class HighLevelAnalyzer:
    result_types = {}

    def __new__(cls, settings=None, *args, **kwargs):
        instance = object.__new__(cls)
        if settings is not None:
            for name, value in resolve_settings(cls, settings).items():
                setattr(instance, name, value)
        return instance

    def decode(self, frame):
        raise NotImplementedError('analyzer must implement decode')
