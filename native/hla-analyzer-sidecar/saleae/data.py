"""Exact rational time objects; implemented independently for pxlogic."""
from decimal import Decimal, localcontext
from fractions import Fraction
import math
from datetime import datetime as DateTime, timezone, timedelta

EPOCH = DateTime(1970, 1, 1, tzinfo=timezone.utc)

def _units(millisecond=0, microsecond=0, nanosecond=0, picosecond=0):
    return (_fraction(millisecond) / 10**3 + _fraction(microsecond) / 10**6
            + _fraction(nanosecond) / 10**9 + _fraction(picosecond) / 10**12)


def _fraction(value):
    if isinstance(value, _Time):
        return value._value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError('time must be finite')
        return Fraction(str(value))
    return Fraction(value)


class _Time:
    __slots__ = ('_value',)

    def __init__(self, seconds=0, microseconds=0, *, milliseconds=0, nanoseconds=0):
        self._value = (_fraction(seconds) + _fraction(microseconds) / 10**6
                       + _fraction(milliseconds) / 10**3 + _fraction(nanoseconds) / 10**9)

    @property
    def fraction(self):
        return self._value

    def __float__(self):
        return float(self._value)

    def __str__(self):
        with localcontext() as ctx:
            ctx.prec = max(40, len(str(abs(self._value.numerator))) + len(str(self._value.denominator)) + 20)
            return str(Decimal(self._value.numerator) / Decimal(self._value.denominator))

    def __repr__(self):
        return f'{type(self).__name__}({self._value!r})'

    def __eq__(self, other):
        if not isinstance(other, _Time):
            return NotImplemented
        return self._value == other._value

    def __lt__(self, other):
        if not isinstance(other, _Time):
            return NotImplemented
        return self._value < other._value

    def __le__(self, other):
        if not isinstance(other, _Time):
            return NotImplemented
        return self._value <= other._value

    def __gt__(self, other):
        if not isinstance(other, _Time):
            return NotImplemented
        return self._value > other._value

    def __ge__(self, other):
        if not isinstance(other, _Time):
            return NotImplemented
        return self._value >= other._value

    def __hash__(self):
        return hash(self._value)


class GraphTime(_Time):
    def __init__(self, datetime=0, millisecond=0, *, microsecond=0, nanosecond=0,
                 picosecond=0, **legacy_units):
        if isinstance(datetime, DateTime):
            value = datetime.replace(tzinfo=timezone.utc) if datetime.tzinfo is None else datetime.astimezone(timezone.utc)
            delta = value - EPOCH
            seconds = Fraction(delta.days * 86400 + delta.seconds) + Fraction(delta.microseconds, 10**6)
        else:
            # Numeric/Fraction construction is used by the host for exact sample conversion.
            seconds = _fraction(datetime)
        self._value = seconds + _units(millisecond, microsecond, nanosecond, picosecond)
        self._value += _legacy_offset(legacy_units)

    def as_datetime(self):
        return EPOCH + timedelta(microseconds=round(self._value * 10**6))

    def __str__(self):
        seconds = self._value.numerator // self._value.denominator
        base = EPOCH + timedelta(seconds=seconds)
        # Public string representation has picosecond precision; arithmetic remains exact.
        picoseconds = (self._value - seconds) * 10**12
        return base.strftime('%Y-%m-%dT%H:%M:%S') + f'.{picoseconds.numerator // picoseconds.denominator:012d}Z'

    def __add__(self, other):
        if not isinstance(other, GraphTimeDelta):
            return NotImplemented
        return GraphTime(self._value + other._value)

    __radd__ = __add__

    def __sub__(self, other):
        if isinstance(other, GraphTime):
            return GraphTimeDelta(self._value - other._value)
        if isinstance(other, GraphTimeDelta):
            return GraphTime(self._value - other._value)
        return NotImplemented


class GraphTimeDelta(_Time):
    def __init__(self, second=0, millisecond=0, *, microsecond=0, nanosecond=0,
                 picosecond=0, **legacy_units):
        self._value = _fraction(second) + _units(millisecond, microsecond, nanosecond, picosecond)
        self._value += _legacy_offset(legacy_units)

    def __add__(self, other):
        if isinstance(other, GraphTime):
            return other + self
        if isinstance(other, GraphTimeDelta):
            return GraphTimeDelta(self._value + other._value)
        return NotImplemented

    __radd__ = __add__

    def __sub__(self, other):
        if not isinstance(other, GraphTimeDelta):
            return NotImplemented
        return GraphTimeDelta(self._value - other._value)

    def __neg__(self):
        return GraphTimeDelta(-self._value)

    def __abs__(self):
        return GraphTimeDelta(abs(self._value))

    def __mul__(self, scalar):
        return GraphTimeDelta(self._value * _fraction(scalar))

    __rmul__ = __mul__

    def __truediv__(self, other):
        if isinstance(other, GraphTimeDelta):
            return self._value / other._value
        return GraphTimeDelta(self._value / _fraction(other))

def _legacy_offset(units):
    aliases = {'seconds': 1, 'milliseconds': 10**3, 'microseconds': 10**6, 'nanoseconds': 10**9}
    if units.keys() - aliases.keys():
        raise TypeError('unsupported time constructor arguments: ' + ', '.join(units.keys() - aliases.keys()))
    return sum((_fraction(value) / aliases[key] for key, value in units.items()), Fraction(0))
