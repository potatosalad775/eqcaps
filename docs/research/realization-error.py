"""How far off are filters on devices that follow devicePEQ's measured realization laws, if nothing
corrects for them? Evidence for prior-art.md §2.1 and DECISIONS D29. Requires numpy.

Intended = RBJ cookbook filter (PK, LSC/HSC Q-parameterized), i.e. what eqcaps' canonical units mean.
Realized = the same RBJ design with the parameters each law says the device actually realizes.
Metric   = max |dB difference| of the magnitude response over 20 Hz - 20 kHz at fs = 48 kHz.
"""
import numpy as np

FS = 48000.0
F = np.geomspace(20, 20000, 4000)
Z1 = np.exp(-1j * 2 * np.pi * F / FS)


def response_db(t, f, q, g):
    A = 10 ** (g / 40)
    w0 = 2 * np.pi * f / FS
    c, s = np.cos(w0), np.sin(w0)
    al = s / (2 * q)
    if t == 'PK':
        b = [1 + al * A, -2 * c, 1 - al * A]
        a = [1 + al / A, -2 * c, 1 - al / A]
    elif t == 'LSC':
        k = 2 * np.sqrt(A) * al
        b = [A * ((A + 1) - (A - 1) * c + k), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - k)]
        a = [(A + 1) + (A - 1) * c + k, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - k]
    elif t == 'HSC':
        k = 2 * np.sqrt(A) * al
        b = [A * ((A + 1) + (A - 1) * c + k), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - k)]
        a = [(A + 1) - (A - 1) * c + k, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - k]
    else:
        raise ValueError(t)
    H = (b[0] + b[1] * Z1 + b[2] * Z1**2) / (a[0] + a[1] * Z1 + a[2] * Z1**2)
    return 20 * np.log10(np.abs(H))


def rbj_a(g):
    return 10 ** (abs(g) / 40)


def shelf_sqrt_a(t, f, g):
    # devicePEQ compensation.js shelfRealisedFromStored: shift by sqrt(A) in the prewarped domain
    d = np.sqrt(rbj_a(g)) if t == 'LSC' else 1 / np.sqrt(rbj_a(g))
    return FS / np.pi * np.arctan(np.tan(np.pi * f / FS) * d)


# Each law maps an intended (type, f, q, gain) to the realized one when the app sends it unchanged.
LAWS = {
    'FiiO QX13/KA17 (rbjGain, PK only)': lambda t, f, q, g: (t, f, q / rbj_a(g) if t == 'PK' else q, g),
    'Fosi DS3 (rbjGain + shelfSqrtA)': lambda t, f, q, g: (
        t, f if t == 'PK' else shelf_sqrt_a(t, f, g), q / rbj_a(g), g),
    'Walkplay SchemeNo11, designFs 49152': lambda t, f, q, g: (t, f * 0.9775, q * np.cos(np.pi * f / 49152), g),
    'Walkplay SchemeNo11, designFs 96000': lambda t, f, q, g: (t, f * 0.9775, q * np.cos(np.pi * f / 96000), g),
    'KTMicro compensate2X (codec corrects)': lambda t, f, q, g: (t, f * 2, q, g),
}

SINGLES = [
    ('PK', 1000, 1.0, 3), ('PK', 1000, 1.0, 6), ('PK', 1000, 2.0, 12), ('PK', 1000, 4.0, -12),
    ('PK', 8000, 4.0, -6), ('PK', 12000, 4.0, -6), ('LSC', 105, 0.7, 6), ('HSC', 10000, 0.7, 4),
]
PRESET = [  # typical AutoEQ-style IEM correction
    ('LSC', 105, 0.70, 6.0), ('PK', 180, 0.9, -2.5), ('PK', 1500, 1.4, 2.0), ('PK', 3200, 2.5, -3.5),
    ('PK', 6000, 4.0, 4.0), ('PK', 8500, 3.0, -5.0), ('HSC', 10000, 0.70, 2.5),
]


def max_error(filters, law):
    want = sum(response_db(*x) for x in filters)
    got = sum(response_db(*law(*x)) for x in filters)
    d = np.abs(got - want)
    i = int(np.argmax(d))
    return d[i], F[i]


if __name__ == '__main__':
    for name, law in LAWS.items():
        print(name)
        for x in SINGLES:
            e, f = max_error([x], law)
            print(f'  {x[0]:3s} {x[1]:6.0f} Hz  Q {x[2]:<4} {x[3]:+3.0f} dB   {e:5.2f} dB  (at {f:5.0f} Hz)')
        e, f = max_error(PRESET, law)
        print(f'  7-filter preset             {e:5.2f} dB  (at {f:5.0f} Hz)')
