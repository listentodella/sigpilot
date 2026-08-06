'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PROFILES_PATH = path.join(
  __dirname,
  '..',
  'compatibility',
  'profiles.json',
);

function align4(value) {
  return (value + 3) & ~3;
}

function formatUuid(bytes) {
  const hex = Buffer.from(bytes).toString('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseMachO(buffer) {
  if (buffer.length < 32 || buffer.readUInt32LE(0) !== 0xfeedfacf) return null;
  const cpuType = buffer.readUInt32LE(4);
  const architecture = cpuType === 0x0100000c ? 'arm64' :
    cpuType === 0x01000007 ? 'x64' : `macho-cpu-${cpuType}`;
  const commandCount = buffer.readUInt32LE(16);
  const commandBytes = buffer.readUInt32LE(20);
  let offset = 32;
  const commandsEnd = Math.min(buffer.length, offset + commandBytes);
  for (let index = 0; index < commandCount && offset + 8 <= commandsEnd; index += 1) {
    const command = buffer.readUInt32LE(offset);
    const size = buffer.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > commandsEnd) break;
    if (command === 0x1b && size >= 24) {
      return {
        format: 'mach-o',
        architecture,
        identityKind: 'macho-lc-uuid',
        identity: formatUuid(buffer.subarray(offset + 8, offset + 24)),
      };
    }
    offset += size;
  }
  return { format: 'mach-o', architecture, identityKind: null, identity: null };
}

function parseElfNotes(buffer, offset, length) {
  const end = Math.min(buffer.length, offset + length);
  while (offset + 12 <= end) {
    const nameLength = buffer.readUInt32LE(offset);
    const descriptionLength = buffer.readUInt32LE(offset + 4);
    const type = buffer.readUInt32LE(offset + 8);
    const nameOffset = offset + 12;
    const descriptionOffset = nameOffset + align4(nameLength);
    const next = descriptionOffset + align4(descriptionLength);
    if (next > end) break;
    const name = buffer.subarray(nameOffset, nameOffset + nameLength).toString('ascii')
      .replace(/\0+$/, '');
    if (name === 'GNU' && type === 3) {
      return buffer.subarray(descriptionOffset, descriptionOffset + descriptionLength)
        .toString('hex');
    }
    offset = next;
  }
  return null;
}

function parseElf(buffer) {
  if (buffer.length < 64 || !buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    return null;
  }
  if (buffer[4] !== 2 || buffer[5] !== 1) {
    throw new Error('Only little-endian ELF64 GraphServer binaries are supported');
  }
  const machine = buffer.readUInt16LE(18);
  const architecture = machine === 62 ? 'x64' : machine === 183 ? 'arm64' : `elf-machine-${machine}`;
  const programOffset = Number(buffer.readBigUInt64LE(32));
  const programEntrySize = buffer.readUInt16LE(54);
  const programCount = buffer.readUInt16LE(56);
  for (let index = 0; index < programCount; index += 1) {
    const header = programOffset + index * programEntrySize;
    if (header + 56 > buffer.length) break;
    if (buffer.readUInt32LE(header) !== 4) continue;
    const noteOffset = Number(buffer.readBigUInt64LE(header + 8));
    const noteLength = Number(buffer.readBigUInt64LE(header + 32));
    const buildId = parseElfNotes(buffer, noteOffset, noteLength);
    if (buildId) {
      return {
        format: 'elf',
        architecture,
        identityKind: 'elf-gnu-build-id',
        identity: buildId,
      };
    }
  }
  return { format: 'elf', architecture, identityKind: null, identity: null };
}

function peRvaToOffset(buffer, sectionOffset, sectionCount, rva) {
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionOffset + index * 40;
    if (offset + 40 > buffer.length) break;
    const virtualSize = buffer.readUInt32LE(offset + 8);
    const virtualAddress = buffer.readUInt32LE(offset + 12);
    const rawSize = buffer.readUInt32LE(offset + 16);
    const rawOffset = buffer.readUInt32LE(offset + 20);
    const span = Math.max(virtualSize, rawSize);
    if (rva >= virtualAddress && rva < virtualAddress + span) {
      return rawOffset + rva - virtualAddress;
    }
  }
  return null;
}

function formatPeGuid(bytes) {
  const part1 = bytes.readUInt32LE(0).toString(16).padStart(8, '0');
  const part2 = bytes.readUInt16LE(4).toString(16).padStart(4, '0');
  const part3 = bytes.readUInt16LE(6).toString(16).padStart(4, '0');
  const tail = bytes.subarray(8).toString('hex');
  return `${part1}-${part2}-${part3}-${tail.slice(0, 4)}-${tail.slice(4)}`.toUpperCase();
}

function parsePe(buffer) {
  if (buffer.length < 64 || buffer.toString('ascii', 0, 2) !== 'MZ') return null;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 24 > buffer.length || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    return null;
  }
  const machine = buffer.readUInt16LE(peOffset + 4);
  const architecture = machine === 0x8664 ? 'x64' :
    machine === 0xaa64 ? 'arm64' : `pe-machine-${machine}`;
  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const timestamp = buffer.readUInt32LE(peOffset + 8);
  const optionalSize = buffer.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  if (optionalOffset + optionalSize > buffer.length) {
    return { format: 'pe', architecture, identityKind: 'pe-timestamp', identity: timestamp.toString(16) };
  }
  const optionalMagic = buffer.readUInt16LE(optionalOffset);
  const directoriesOffset = optionalOffset + (optionalMagic === 0x20b ? 112 : 96);
  const debugDirectory = directoriesOffset + 6 * 8;
  const sectionOffset = optionalOffset + optionalSize;
  if (debugDirectory + 8 <= buffer.length) {
    const debugRva = buffer.readUInt32LE(debugDirectory);
    const debugSize = buffer.readUInt32LE(debugDirectory + 4);
    const debugOffset = peRvaToOffset(buffer, sectionOffset, sectionCount, debugRva);
    if (debugOffset !== null) {
      for (let offset = debugOffset; offset + 28 <= debugOffset + debugSize; offset += 28) {
        if (buffer.readUInt32LE(offset + 12) !== 2) continue;
        const dataSize = buffer.readUInt32LE(offset + 16);
        const dataOffset = buffer.readUInt32LE(offset + 24);
        if (dataSize < 24 || dataOffset + dataSize > buffer.length) continue;
        if (buffer.toString('ascii', dataOffset, dataOffset + 4) !== 'RSDS') continue;
        const guid = formatPeGuid(buffer.subarray(dataOffset + 4, dataOffset + 20));
        const age = buffer.readUInt32LE(dataOffset + 20);
        return {
          format: 'pe',
          architecture,
          identityKind: 'pe-codeview-guid-age',
          identity: `${guid}-${age}`,
          timestamp,
        };
      }
    }
  }
  return {
    format: 'pe',
    architecture,
    identityKind: 'pe-timestamp',
    identity: timestamp.toString(16).padStart(8, '0'),
    timestamp,
  };
}

function parseBinaryIdentity(buffer) {
  return parseMachO(buffer) || parseElf(buffer) || parsePe(buffer) || {
    format: 'unknown',
    architecture: 'unknown',
    identityKind: null,
    identity: null,
  };
}

function inspectGraphBinary(graphPath) {
  const buffer = fs.readFileSync(graphPath);
  return {
    path: graphPath,
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    ...parseBinaryIdentity(buffer),
  };
}

function loadCompatibilityProfiles(profilesPath = DEFAULT_PROFILES_PATH) {
  const manifest = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.profiles)) {
    throw new Error(`Unsupported compatibility profile manifest: ${profilesPath}`);
  }
  return manifest.profiles;
}

function matchCompatibilityProfile({
  logicVersion,
  platform,
  architecture,
  graphPath,
  profiles = loadCompatibilityProfiles(),
}) {
  const fingerprint = inspectGraphBinary(graphPath);
  const candidates = profiles.filter(profile =>
    profile.logicVersion === logicVersion &&
    profile.platform === platform &&
    profile.architecture === architecture,
  );
  const profile = candidates.find(candidate =>
    fingerprint.identity !== null &&
    candidate.graph.sha256.toLowerCase() === fingerprint.sha256.toLowerCase() &&
    candidate.graph.identityKind === fingerprint.identityKind &&
    candidate.graph.identity.toLowerCase() === fingerprint.identity.toLowerCase(),
  );
  return {
    fingerprint,
    profile: profile || null,
    supported: profile?.hook.status === 'verified',
  };
}

module.exports = {
  DEFAULT_PROFILES_PATH,
  inspectGraphBinary,
  loadCompatibilityProfiles,
  matchCompatibilityProfile,
  parseBinaryIdentity,
};
