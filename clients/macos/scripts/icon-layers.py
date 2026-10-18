"""Extract unmasked foreground layers; Icon Composer supplies lighting and background."""
from copy import deepcopy
from pathlib import Path
import xml.etree.ElementTree as ET

artwork = Path(__file__).resolve().parents[1] / "Artwork"
namespace = "http://www.w3.org/2000/svg"
ET.register_namespace("", namespace)
source = ET.parse(artwork / "AppIcon.svg").getroot()
definitions = source.find(f"{{{namespace}}}defs")
pet = source.find(f"{{{namespace}}}g")
destination = artwork / "AppIcon.icon/Assets"
destination.mkdir(parents=True, exist_ok=True)
# Skip baked highlights and shadows: the system applies these to the glass layers.
for name, elements in {"Arms": [pet[0]], "Body": [pet[2]], "Face": list(pet)[4:]}.items():
    root = ET.Element(f"{{{namespace}}}svg", width="1024", height="1024", viewBox="0 0 1024 1024")
    root.append(deepcopy(definitions))
    for element in elements:
        root.append(deepcopy(element))
    ET.indent(root)
    ET.ElementTree(root).write(destination / f"{name}.svg", encoding="utf-8", xml_declaration=True)
