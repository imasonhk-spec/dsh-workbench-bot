from xml.etree import ElementTree as ET


class NoDoctype(ET.TreeBuilder):
    def doctype(self, name, pubid, system):
        raise ValueError('XML document types and entities are unsupported')


def parse_xml(data):
    return ET.fromstring(data, parser=ET.XMLParser(target=NoDoctype()))
