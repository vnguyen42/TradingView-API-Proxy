const JSZip = require('jszip');
const zlib = require('zlib');
const { promisify } = require('util');

const inflate = promisify(zlib.inflate);

/**
 * @typedef {Object} TWPacket
 * @prop {string} [m] Packet type
 * @prop {[session: string, {}]} [p] Packet data
 */

const cleanerRgx = /~h~/g;
const splitterRgx = /~m~[0-9]{1,}~m~/g;

function parseJSONBuffer(buffer) {
  return JSON.parse(buffer.toString('utf8'));
}

function decodeBase64(data) {
  let normalized = String(data).trim().replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4;
  if (padding) normalized += '='.repeat(4 - padding);
  return Buffer.from(normalized, 'base64');
}

function describeCompressedPayload(data) {
  const input = String(data || '');
  const decoded = decodeBase64(input);
  let decodedMagic = 'unknown';
  if (decoded[0] === 0x50 && decoded[1] === 0x4b) decodedMagic = 'zip';
  else if (decoded[0] === 0x78) decodedMagic = 'zlib';

  return {
    inputLength: input.length,
    decodedLength: decoded.length,
    decodedHexPrefix: decoded.subarray(0, 8).toString('hex'),
    decodedMagic,
  };
}

async function parseZipCompressed(data) {
  const zip = new JSZip();
  const archive = await zip.loadAsync(data, { base64: true });
  const file = archive.file('') || archive.file(Object.keys(archive.files)[0]);
  if (!file) throw new Error('ZIP payload has no file entries');
  return JSON.parse(await file.async('text'));
}

async function parseZlibCompressed(data) {
  return parseJSONBuffer(await inflate(decodeBase64(data)));
}

module.exports = {
  /**
   * Parse websocket packet
   * @function parseWSPacket
   * @param {string} str Websocket raw data
   * @returns {TWPacket[]} TradingView packets
   */
  parseWSPacket(str) {
    return str.replace(cleanerRgx, '').split(splitterRgx)
      .map((p) => {
        if (!p) return false;
        try {
          return JSON.parse(p);
        } catch (error) {
          console.warn('Cant parse', p);
          return false;
        }
      })
      .filter((p) => p);
  },

  /**
   * Format websocket packet
   * @function formatWSPacket
   * @param {TWPacket} packet TradingView packet
   * @returns {string} Websocket raw data
   */
  formatWSPacket(packet) {
    const msg = typeof packet === 'object'
      ? JSON.stringify(packet)
      : packet;
    return `~m~${msg.length}~m~${msg}`;
  },

  /**
   * Parse compressed data
   * @function parseCompressed
   * @param {string} data Compressed data
   * @returns {Promise<{}>} Parsed data
   */
  async parseCompressed(data) {
    const decoded = decodeBase64(data);

    if (decoded[0] === 0x78) return parseZlibCompressed(data);
    if (decoded[0] === 0x50 && decoded[1] === 0x4b) return parseZipCompressed(data);

    const errors = [];
    try {
      return await parseZipCompressed(data);
    } catch (error) {
      errors.push(`zip: ${error && error.message ? error.message : error}`);
    }

    try {
      return await parseZlibCompressed(data);
    } catch (error) {
      errors.push(`zlib: ${error && error.message ? error.message : error}`);
    }

    throw new Error(`Unsupported compressed TradingView payload (${errors.join('; ')})`);
  },

  describeCompressedPayload,
};
