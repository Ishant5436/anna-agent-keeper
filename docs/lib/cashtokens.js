/**
 * CashTokens (CHIP-2022-02) token prefix encoding.
 *
 * This is real encoding, checked against the CHIP's official test vectors in
 * tests/vectors. It produces the bytes that precede an output's locking
 * bytecode; it does not build, sign or broadcast a transaction.
 */

const PREFIX_TOKEN = 0xef;
const HAS_AMOUNT = 0x10;
const HAS_NFT = 0x20;
const HAS_COMMITMENT_LENGTH = 0x40;
const CAPABILITIES = Object.freeze({ none: 0x00, mutable: 0x01, minting: 0x02 });

export const MAX_FT_AMOUNT = 9223372036854775807n; // maximum VM number
export const CONSENSUS_MAX_COMMITMENT_BYTES = 40; // CHIP-2022-02 consensus limit

const isHex = (s) => /^([0-9a-fA-F]{2})*$/.test(s);

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function littleEndian(value, byteLength) {
  const out = [];
  let v = value;
  for (let i = 0; i < byteLength; i++) {
    out.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return out;
}

/** Minimal CompactSize encoding of a non-negative integer. */
export function compactSize(value) {
  const v = BigInt(value);
  if (v < 0n) throw new Error("CompactSize value must not be negative.");
  if (v < 0xfdn) return [Number(v)];
  if (v <= 0xffffn) return [0xfd, ...littleEndian(v, 2)];
  if (v <= 0xffffffffn) return [0xfe, ...littleEndian(v, 4)];
  return [0xff, ...littleEndian(v, 8)];
}

/**
 * Encodes a token prefix.
 * @param {object} token
 * @param {string} token.category  Category ID as shown in explorers (64 hex chars).
 * @param {bigint|string|number} [token.amount]  Fungible token amount (0 for none).
 * @param {{capability: "none"|"mutable"|"minting", commitment?: string}|null} [token.nft]
 * @returns {string} prefix as lowercase hex
 */
export function encodeTokenPrefix({ category, amount = 0n, nft = null }) {
  if (typeof category !== "string" || !/^[0-9a-fA-F]{64}$/.test(category)) {
    throw new Error("Category ID must be 32 bytes of hex (64 hex characters).");
  }
  const ft = BigInt(amount);
  if (ft < 0n || ft > MAX_FT_AMOUNT) {
    throw new Error(`Fungible amount must be from 0 to ${MAX_FT_AMOUNT}.`);
  }

  let bitfield = 0;
  let commitment = new Uint8Array(0);
  if (nft) {
    if (!(nft.capability in CAPABILITIES)) throw new Error(`Unknown NFT capability: ${nft.capability}`);
    const hex = nft.commitment || "";
    if (!isHex(hex)) throw new Error("NFT commitment must be hex bytes (an even number of hex characters).");
    commitment = hexToBytes(hex);
    bitfield |= HAS_NFT | CAPABILITIES[nft.capability];
    if (commitment.length > 0) bitfield |= HAS_COMMITMENT_LENGTH;
  }
  if (ft > 0n) bitfield |= HAS_AMOUNT;
  if (!(bitfield & (HAS_NFT | HAS_AMOUNT))) {
    throw new Error("A token prefix must carry fungible tokens, an NFT, or both.");
  }

  // Category IDs are displayed reversed (like transaction IDs); the prefix
  // stores them in OP_HASH256 byte order.
  const categoryBytes = hexToBytes(category).reverse();
  const bytes = [PREFIX_TOKEN, ...categoryBytes, bitfield];
  if (commitment.length > 0) bytes.push(...compactSize(commitment.length), ...commitment);
  if (ft > 0n) bytes.push(...compactSize(ft));
  return bytesToHex(bytes);
}
