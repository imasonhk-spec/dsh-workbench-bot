import json
import re
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape
from safe_xml import parse_xml

mode, source, target = sys.argv[1:4]
if mode == 'read':
    with zipfile.ZipFile(source) as package:
        info = package.getinfo('word/document.xml')
        if info.file_size > 2_000_000:
            raise ValueError('DOCX text is too large')
        xml = package.read(info)
        document = parse_xml(xml)
        ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
        text = '\n'.join(''.join(p.itertext()) for p in document.iter(ns + 'p'))
        Path(target).write_text(text, encoding='utf-8')
else:
    text = Path(source).read_text(encoding='utf-8')
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', text)
    paragraphs = ''.join('<w:p><w:r><w:t xml:space="preserve">' + escape(line) + '</w:t></w:r></w:p>' for line in text.split('\n'))
    document = '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paragraphs + '</w:body></w:document>'
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as package:
        package.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        package.writestr('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        package.writestr('word/document.xml', document)
print(json.dumps({'ok': True}))
