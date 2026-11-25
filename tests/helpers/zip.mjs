// Stored ZIP entries keep generated fixtures deterministic and dependency-free.
export function createZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const [name, value] of entries) {
    const filename = Buffer.from(name);
    const data = Buffer.from(value);
    let crc = 0xffffffff;

    for (const byte of data) {
      crc ^= byte;

      for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }

    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    local.push(header, filename, data);
    central.push(record, filename);
    offset += header.length + filename.length + data.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...local, directory, end]);
}
