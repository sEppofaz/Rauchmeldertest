#!/usr/bin/env python3
"""Migriert Rauchmeldertest-Reiter aus Excel nach rauchmelder.json."""

import json, re, uuid
from datetime import datetime, timedelta
from pathlib import Path

EXCEL_PATH = Path.home() / 'Library/CloudStorage/Dropbox/Apps/Claude/Messdaten/Messdaten sEpp-Claude.xlsx'
OUT_PATH   = Path.home() / 'Library/CloudStorage/Dropbox/Apps/Claude/Messdaten/rauchmelder.json'

import openpyxl

def excel_to_date(serial):
    # Excel-Datei nutzt 1904-Datumsbasis (Mac Excel)
    return (datetime(1904, 1, 1) + timedelta(days=int(serial) - 1)).strftime('%Y-%m-%d')

def header_to_date(h):
    if isinstance(h, int) and h > 40000:
        return excel_to_date(h)
    if isinstance(h, int):
        return f"{h}-12-31"
    return None

def parse_aktivierung(v):
    if v is None:
        return None
    if isinstance(v, int) and v > 40000:
        return excel_to_date(v)
    if isinstance(v, int):
        return f"{v}-01-01"
    s = str(v).strip()
    if 'Mitte' in s:
        y = re.search(r'\d{4}', s)
        return f"{y.group()}-06-01" if y else None
    return None

def detect_typ(name):
    n = name.lower()
    if 'feuerlöscher' in n or 'feuerlöscher' in n:
        return 'Feuerlöscher'
    if 'löschdose' in n:
        return 'Löschdose'
    return 'Rauchmelder'

def parse_pruefung(header_val, cell_val):
    """Gibt (datum, ergebnis, bemerkung) oder None zurück."""
    if cell_val is None:
        return None
    hd = header_to_date(header_val)

    if isinstance(cell_val, int) and cell_val > 40000:
        return (excel_to_date(cell_val), 'ok', '')

    if isinstance(cell_val, (int, float)):
        return None

    s = str(cell_val).strip()
    if not s:
        return None

    sl = s.lower()
    if sl == 'ok':
        return (hd, 'ok', '')
    if 'batterie leer' in sl:
        return (hd, 'Batterie leer', s)
    if sl.startswith('bis '):
        return None

    # "DD.MM.YY ok", "DD.MM.YYYY ok", "DD.MM.YY"
    m = re.match(r'(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s*(.*)', s)
    if m:
        d, mo, y, rest = m.groups()
        if len(y) == 2:
            y = '20' + y
        # Ungültige Daten (z.B. 30.02) auf letzten des Monats kürzen
        try:
            datum = datetime(int(y), int(mo), int(d)).strftime('%Y-%m-%d')
        except ValueError:
            # Letzter Tag des Monats
            import calendar
            last = calendar.monthrange(int(y), int(mo))[1]
            datum = datetime(int(y), int(mo), last).strftime('%Y-%m-%d')
        erg = rest.strip().lower()
        if not erg or erg == 'ok':
            ergebnis = 'ok'
        else:
            ergebnis = rest.strip()
        return (datum, ergebnis, '')

    # Unbekanntes Format → als Bemerkung
    return (hd, 'unbekannt', s)


def main():
    wb = openpyxl.load_workbook(str(EXCEL_PATH), data_only=True)
    ws = wb['Rauchmeldertest']
    rows = list(ws.iter_rows(values_only=True))
    header = rows[0]

    # Prüf-Spalten: Index 9–17
    pruef_cols = list(range(9, 18))

    geraete  = []
    pruefungen = []
    current_ort = None

    for row in rows[1:]:
        if not any(c is not None for c in row):
            continue

        ort_val  = row[0]
        name_val = row[1]
        if name_val is None:
            continue

        if ort_val:
            current_ort = str(ort_val).strip()

        name   = str(name_val).strip()
        aktiv  = parse_aktivierung(row[2])
        laufzeit = None
        ablauf   = None

        lv = row[3]
        if isinstance(lv, int) and lv < 100:
            laufzeit = lv
        elif isinstance(lv, str):
            # "3/2028" → ablauf = "2028-03-01"
            m = re.match(r'(\d{1,2})/(\d{4})', lv)
            if m:
                ablauf = f"{m.group(2)}-{m.group(1).zfill(2)}-01"

        if aktiv and laufzeit and not ablauf:
            try:
                dy = datetime.strptime(aktiv, '%Y-%m-%d')
                ablauf = datetime(dy.year + laufzeit, dy.month, dy.day).strftime('%Y-%m-%d')
            except ValueError:
                pass

        bemerkung = str(row[4]).strip() if row[4] else ''
        modell    = str(row[6]).strip() if row[6] else ''
        pruefmethode = str(row[7]).strip() if row[7] else ''
        weitere   = str(row[8]).replace('\n', ' ').strip() if row[8] else ''

        gid = 'g' + str(uuid.uuid4())[:8]
        geraete.append({
            'id':           gid,
            'ort':          current_ort or '',
            'name':         name,
            'typ':          detect_typ(name),
            'aktivierung':  aktiv,
            'laufzeit_jahre': laufzeit,
            'ablauf':       ablauf,
            'modell':       modell,
            'pruefmethode': pruefmethode,
            'weitere_pruefungen': weitere,
            'bemerkung':    bemerkung,
        })

        for ci in pruef_cols:
            result = parse_pruefung(header[ci], row[ci])
            if result is None:
                continue
            datum, ergebnis, bem = result
            if datum is None:
                continue
            pruefungen.append({
                'geraet_id': gid,
                'datum':     datum,
                'ergebnis':  ergebnis,
                'bemerkung': bem,
            })

    pruefungen.sort(key=lambda p: p['datum'])

    data = {'v': 1, 'geraete': geraete, 'pruefungen': pruefungen}
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"✅ {len(geraete)} Geräte, {len(pruefungen)} Prüfungen → {OUT_PATH}")
    for g in geraete:
        ps = [p for p in pruefungen if p['geraet_id'] == g['id']]
        last = ps[-1]['datum'] if ps else '–'
        print(f"  {g['ort']:12} | {g['name']:35} | {g['typ']:12} | ablauf={g['ablauf']} | letzte={last} | {len(ps)} Prüf.")

if __name__ == '__main__':
    main()
