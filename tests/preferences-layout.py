"""Reject overlapping grid cells and misplaced layout metadata in Settings.ui."""
from pathlib import Path
import xml.etree.ElementTree as ET

root = ET.parse(Path(__file__).resolve().parents[1] / 'Settings.ui').getroot()
parents = {child: parent for parent in root.iter() for child in parent}
for widget in root.iter('object'):
    if widget.find('layout') is not None:
        parent = parents.get(widget)
        while parent is not None and parent.tag != 'object':
            parent = parents.get(parent)
        assert parent is not None and parent.get('class') == 'GtkGrid', widget.get('id')
    if widget.get('class') != 'GtkGrid':
        continue
    occupied = {}
    for child in widget.findall('child'):
        control = child.find('object')
        if control is None:
            continue
        layout = {p.get('name'): int(p.text) for p in control.findall('layout/property')}
        for column in range(layout.get('column', 0),
                            layout.get('column', 0) + layout.get('column-span', 1)):
            for row in range(layout.get('row', 0),
                             layout.get('row', 0) + layout.get('row-span', 1)):
                assert (column, row) not in occupied, (widget.get('id'), control.get('id'))
                occupied[column, row] = control.get('id')
print('Preferences layout: no overlapping grids or invalid child layouts')
