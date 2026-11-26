from argparse import ArgumentParser
from pathlib import Path
from xml.etree import ElementTree as XML

ROOT = Path(__file__).resolve().parent.parent
SVG = ROOT / "src/img/nexustavern-mark.svg"
ANDROID_RES = ROOT / "src-tauri/crates/tauritavern/gen/android/app/src/local/res"
ANDROID_NS = "http://schemas.android.com/apk/res/android"
SVG_NS = {"svg": "http://www.w3.org/2000/svg"}


def android_attributes(**attributes):
    return {f"{{{ANDROID_NS}}}{name}": value for name, value in attributes.items()}


def android_layers():
    source = XML.parse(SVG).getroot()
    badge = source.find("svg:rect[@id='badge']", SVG_NS)
    mark = source.find("svg:path[@id='mark']", SVG_NS)
    if badge is None or mark is None:
        raise ValueError("The NexusTavern SVG requires its badge rectangle and mark path.")

    XML.register_namespace("android", ANDROID_NS)
    foreground = XML.Element("vector", android_attributes(
        width="108dp", height="108dp", viewportWidth="108", viewportHeight="108",
    ))
    XML.SubElement(foreground, "path", android_attributes(
        pathData=mark.attrib["d"],
        fillColor="#00000000",
        strokeColor=mark.attrib["stroke"],
        strokeWidth=mark.attrib["stroke-width"],
        strokeLineCap=mark.attrib["stroke-linecap"],
        strokeLineJoin=mark.attrib["stroke-linejoin"],
    ))

    colors = XML.Element("resources")
    XML.SubElement(colors, "color", name="nexustavern_icon_background").text = badge.attrib["fill"]
    return {
        "drawable/nexustavern_mark.xml": foreground,
        "values/nexustavern_icon_colors.xml": colors,
    }


def main():
    parser = ArgumentParser(description="Export the Android icon layers from the NexusTavern SVG.")
    parser.add_argument("--check", action="store_true", help="Check whether the exported layers are current.")
    args = parser.parse_args()
    stale = []
    for relative_path, resource in android_layers().items():
        XML.indent(resource, space="    ")
        content = XML.tostring(resource, encoding="utf-8", xml_declaration=True) + b"\n"
        path = ANDROID_RES / relative_path
        if args.check:
            if not path.is_file() or path.read_bytes() != content:
                stale.append(relative_path)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    if stale:
        parser.error(f"Regenerate the NexusTavern icon layers for {', '.join(stale)}.")


if __name__ == "__main__":
    main()
