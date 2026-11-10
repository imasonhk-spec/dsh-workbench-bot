import posixpath
import struct
import sys
import zlib
from pathlib import Path
from zipfile import ZipFile
from safe_xml import parse_xml


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify_ppt(filename, count):
    p = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
    r = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
    with ZipFile(filename) as package:
        entries = package.infolist()
        names = set(package.namelist())
        require(len(entries) == len(names) and len(entries) <= 10000, 'ZIP contains duplicate or too many entries')
        require(sum(i.file_size for i in entries) <= 512 * 1024 * 1024, 'ZIP expands beyond size limit')
        for info in entries:
            require(info.file_size <= 128 * 1024 * 1024 and not info.flag_bits & 1, 'ZIP entry too large or encrypted')
            require(not info.filename.startswith('/') and '..' not in info.filename.split('/'), 'Unsafe ZIP entry')
        require(package.testzip() is None, 'ZIP CRC check failed')
        xml = {}
        for name in names:
            if name.endswith(('.xml', '.rels')):
                require(package.getinfo(name).file_size <= 16 * 1024 * 1024, 'XML exceeds size limit')
                data = package.read(name)
                xml[name] = parse_xml(data)
        require('[Content_Types].xml' in xml and '_rels/.rels' in xml, 'PPTX package metadata missing')
        require(xml['[Content_Types].xml'].tag == '{http://schemas.openxmlformats.org/package/2006/content-types}Types', 'Invalid content types')
        require(any(x.get('Type', '').endswith('/officeDocument') and x.get('Target', '').lstrip('/') == 'ppt/presentation.xml' for x in xml['_rels/.rels']), 'Presentation relationship missing')
        document = xml['ppt/presentation.xml']
        require(document.tag == p + 'presentation', 'Invalid presentation XML')
        relationships = {x.get('Id'): x for x in xml['ppt/_rels/presentation.xml.rels']}
        slides = document.findall(p + 'sldIdLst/' + p + 'sldId')
        require(len(slides) == count and len({s.get('id') for s in slides}) == count, 'Actual slide count differs from requested count')
        targets = []
        for slide in slides:
            link = relationships[slide.get(r + 'id')]
            require(link.get('Type', '').endswith('/slide') and link.get('TargetMode') != 'External', 'Invalid slide relationship')
            target = link.get('Target', '')
            target = target.lstrip('/') if target.startswith('/') else posixpath.normpath('ppt/' + target)
            require(target.startswith('ppt/slides/') and target in xml and xml[target].tag == p + 'sld', 'Slide part missing or invalid')
            require(xml[target].find(p + 'cSld/' + p + 'spTree') is not None, 'Slide has no shape tree')
            targets.append(target)
        slide_parts = {name for name, root in xml.items() if root.tag == p + 'sld'}
        require(len(set(targets)) == count and set(targets) == slide_parts, 'Duplicate or extra slide parts')


def verify_png(filename):
    require(Path(filename).stat().st_size <= 64 * 1024 * 1024, 'PNG exceeds size limit')
    data = Path(filename).read_bytes()
    require(data.startswith(b'\x89PNG\r\n\x1a\n'), 'Invalid PNG signature')
    offset, kinds, compressed, header, palette_size = 8, [], bytearray(), None, None
    while offset < len(data):
        require(offset + 12 <= len(data), 'Truncated PNG chunk')
        size = struct.unpack_from('>I', data, offset)[0]
        kind, body = data[offset + 4:offset + 8], data[offset + 8:offset + 8 + size]
        end = offset + 12 + size
        require(end <= len(data), 'Truncated PNG data')
        require(zlib.crc32(kind + body) == struct.unpack_from('>I', data, end - 4)[0], 'PNG CRC mismatch')
        require(kind in [b'IHDR', b'PLTE', b'IDAT', b'IEND'] or kind[0] & 32, 'Unknown critical PNG chunk')
        if kind == b'IHDR':
            require(not kinds and size == 13, 'Invalid PNG header')
            header = struct.unpack('>IIBBBBB', body)
        if kind == b'IDAT':
            require(not kinds or kinds[-1] in [b'IHDR', b'PLTE', b'IDAT'] or b'IDAT' not in kinds, 'Nonconsecutive PNG image chunks')
            compressed.extend(body)
        if kind == b'PLTE':
            require(header and b'PLTE' not in kinds and b'IDAT' not in kinds, 'Invalid PNG palette order')
            require(size > 0 and size % 3 == 0 and size <= 768, 'Invalid PNG palette size')
            palette_size = size // 3
        kinds.append(kind)
        offset = end
        if kind == b'IEND':
            require(size == 0 and end == len(data), 'Invalid PNG end')
            break
    require(header and kinds[-1] == b'IEND' and compressed, 'PNG image data or end missing')
    width, height, depth, color, compression, filtering, interlace = header
    allowed = {0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]}
    require(width > 0 and height > 0 and width * height <= 50_000_000, 'Invalid PNG dimensions')
    require(depth in allowed.get(color, []) and compression == filtering == 0 and interlace in [0, 1], 'Unsupported PNG header')
    require(color != 3 or b'PLTE' in kinds, 'Indexed PNG palette missing')
    require(color != 3 or palette_size <= 1 << depth, 'PNG palette exceeds bit depth')
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
    passes = [(0, 0, 1, 1)] if not interlace else [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]
    rows = []
    for x, y, dx, dy in passes:
        w, h = max(0, (width - x + dx - 1) // dx), max(0, (height - y + dy - 1) // dy)
        if w and h:
            rows.extend([(w * channels * depth + 7) // 8 + 1] * h)
    expected = sum(rows)
    require(expected <= 256 * 1024 * 1024, 'PNG decoded image too large')
    decoder = zlib.decompressobj()
    pixels = decoder.decompress(compressed, expected + 1)
    require(decoder.eof and not decoder.unused_data and len(pixels) == expected, 'Invalid PNG compressed scanlines')
    offset = 0
    for size in rows:
        require(pixels[offset] <= 4, 'Invalid PNG scanline filter')
        offset += size


try:
    count = int(sys.argv[2])
    require(len(sys.argv[3:]) == count, 'Preview page count mismatch')
    verify_ppt(sys.argv[1], count)
    for filename in sys.argv[3:]:
        verify_png(filename)
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
