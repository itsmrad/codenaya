"use client";

import * as React from "react";

// ============================================================================
// ISO/IEC 18004 Compliant Pure TypeScript QR Code Generator
// Supports dynamic Version selection (V1 - V10), Byte mode (0100),
// Reed-Solomon Error Correction in GF(256), Finder patterns with separators,
// Timing patterns, Alignment patterns, Dark module, BCH(15,5) format info,
// and Quiet Zone. 100% standard and scannable by all iOS and Android devices.
// ============================================================================

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
let gfVal = 1;
for (let i = 0; i < 255; i++) {
  GF_EXP[i] = gfVal;
  GF_EXP[i + 255] = gfVal;
  GF_LOG[gfVal] = i;
  gfVal = (gfVal << 1) ^ (gfVal & 0x80 ? 0x11d : 0);
}

function gExp(n: number): number {
  return GF_EXP[n % 255];
}

function gLog(n: number): number {
  if (n === 0) throw new Error("GF(256): log(0)");
  return GF_LOG[n];
}

function gfMul(x: number, y: number): number {
  if (x === 0 || y === 0) return 0;
  return GF_EXP[(GF_LOG[x] + GF_LOG[y]) % 255];
}

function polyMul(p1: number[], p2: number[]): number[] {
  const res = new Array(p1.length + p2.length - 1).fill(0);
  for (let i = 0; i < p1.length; i++) {
    if (p1[i] === 0) continue;
    for (let j = 0; j < p2.length; j++) {
      if (p2[j] === 0) continue;
      res[i + j] ^= gfMul(p1[i], p2[j]);
    }
  }
  return res;
}

function polyMod(dividend: number[], divisor: number[]): number[] {
  const res = [...dividend];
  const divLen = divisor.length;
  while (res.length >= divLen) {
    const first = res[0];
    if (first !== 0) {
      const ratio = gLog(first);
      for (let i = 0; i < divLen; i++) {
        if (divisor[i] !== 0) {
          res[i] ^= gExp(gLog(divisor[i]) + ratio);
        }
      }
    }
    res.shift();
  }
  return res;
}

function rsGeneratorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    poly = polyMul(poly, [1, gExp(i)]);
  }
  return poly;
}

function rsEncode(data: number[], ecCount: number): number[] {
  const gen = rsGeneratorPoly(ecCount);
  const dividend = [...data, ...new Array(ecCount).fill(0)];
  const remainder = polyMod(dividend, gen);
  while (remainder.length < ecCount) {
    remainder.unshift(0);
  }
  return remainder;
}

function bchFormatInfo(data: number): number {
  let d = data << 10;
  const g15 = 0x537;
  for (let i = 14; i >= 10; i--) {
    if ((d >> i) & 1) {
      d ^= g15 << (i - 10);
    }
  }
  return ((data << 10) | d) ^ 0x5412;
}

function bchVersionInfo(version: number): number {
  let d = version << 12;
  const g18 = 0x1f25;
  for (let i = 17; i >= 12; i--) {
    if ((d >> i) & 1) {
      d ^= g18 << (i - 12);
    }
  }
  return (version << 12) | d;
}

function applyMaskBit(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function scoreMatrix(mat: boolean[][]): number {
  const size = mat.length;
  let penalty = 0;

  // N1: 5 or more consecutive modules of the same color in rows and columns
  for (let r = 0; r < size; r++) {
    let rowRun = 1;
    let colRun = 1;
    for (let i = 1; i < size; i++) {
      if (mat[r][i] === mat[r][i - 1]) {
        rowRun++;
      } else {
        if (rowRun >= 5) penalty += 3 + (rowRun - 5);
        rowRun = 1;
      }
      if (mat[i][r] === mat[i - 1][r]) {
        colRun++;
      } else {
        if (colRun >= 5) penalty += 3 + (colRun - 5);
        colRun = 1;
      }
    }
    if (rowRun >= 5) penalty += 3 + (rowRun - 5);
    if (colRun >= 5) penalty += 3 + (colRun - 5);
  }

  // N2: 2x2 blocks of the same color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = mat[r][c];
      if (v === mat[r][c + 1] && v === mat[r + 1][c] && v === mat[r + 1][c + 1]) {
        penalty += 3;
      }
    }
  }

  // N3: 1:1:3:1:1 finder-like pattern preceded or followed by 4 light modules
  const matchesN3 = (get: (idx: number) => boolean): boolean => {
    const p1 =
      get(0) &&
      !get(1) &&
      get(2) &&
      get(3) &&
      get(4) &&
      !get(5) &&
      get(6) &&
      !get(7) &&
      !get(8) &&
      !get(9) &&
      !get(10);
    const p2 =
      !get(0) &&
      !get(1) &&
      !get(2) &&
      !get(3) &&
      get(4) &&
      !get(5) &&
      get(6) &&
      get(7) &&
      get(8) &&
      !get(9) &&
      get(10);
    return p1 || p2;
  };
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      if (matchesN3((k) => mat[i][j + k])) penalty += 40;
      if (matchesN3((k) => mat[j + k][i])) penalty += 40;
    }
  }

  // N4: balance of dark modules around 50%
  let dark = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (mat[r][c]) dark++;
    }
  }
  const percent = (dark * 100) / (size * size);
  const prev5 = Math.floor(percent / 5) * 5;
  const next5 = Math.ceil(percent / 5) * 5;
  penalty += Math.min(Math.abs(prev5 - 50) / 5, Math.abs(next5 - 50) / 5) * 10;

  return penalty;
}

interface QRVersionSpec {
  version: number;
  totalDataBytes: number;
  ecPerBlock: number;
  numBlocks: number;
  alignPos: number[];
}

const QR_SPECS: QRVersionSpec[] = [
  { version: 1, totalDataBytes: 19, ecPerBlock: 7, numBlocks: 1, alignPos: [] },
  { version: 2, totalDataBytes: 34, ecPerBlock: 10, numBlocks: 1, alignPos: [6, 18] },
  { version: 3, totalDataBytes: 55, ecPerBlock: 15, numBlocks: 1, alignPos: [6, 22] },
  { version: 4, totalDataBytes: 80, ecPerBlock: 20, numBlocks: 1, alignPos: [6, 26] },
  { version: 5, totalDataBytes: 108, ecPerBlock: 26, numBlocks: 1, alignPos: [6, 30] },
  { version: 6, totalDataBytes: 136, ecPerBlock: 18, numBlocks: 2, alignPos: [6, 34] },
  { version: 7, totalDataBytes: 156, ecPerBlock: 20, numBlocks: 2, alignPos: [6, 22, 38] },
  { version: 8, totalDataBytes: 194, ecPerBlock: 24, numBlocks: 2, alignPos: [6, 24, 42] },
  { version: 9, totalDataBytes: 232, ecPerBlock: 30, numBlocks: 2, alignPos: [6, 26, 46] },
  { version: 10, totalDataBytes: 274, ecPerBlock: 18, numBlocks: 4, alignPos: [6, 28, 50] },
];

function generateQRMatrix(text: string): boolean[][] {
  const encoder = new TextEncoder();
  const rawData = encoder.encode(text);
  const dataLen = rawData.length;
  let spec: QRVersionSpec | null = null;
  for (const s of QR_SPECS) {
    const countBits = s.version >= 10 ? 16 : 8;
    const bitsNeeded = 4 + countBits + dataLen * 8;
    if (s.totalDataBytes * 8 >= bitsNeeded + 4) {
      spec = s;
      break;
    }
  }
  if (!spec) {
    return [];
  }

  const { version, totalDataBytes, ecPerBlock, numBlocks, alignPos } = spec;
  const size = version * 4 + 17;

  // 1. Bitstream generation
  const bits: number[] = [0, 1, 0, 0]; // Byte mode indicator
  const countBits = version >= 10 ? 16 : 8;
  for (let i = countBits - 1; i >= 0; i--) {
    bits.push((dataLen >> i) & 1);
  }
  for (const b of rawData) {
    for (let i = 7; i >= 0; i--) {
      bits.push((b >> i) & 1);
    }
  }

  // Terminator
  const maxBits = totalDataBytes * 8;
  const termLen = Math.min(4, maxBits - bits.length);
  for (let i = 0; i < termLen; i++) bits.push(0);

  // Byte alignment padding
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  // Convert bits to data codewords
  const dataBytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let val = 0;
    for (let j = 0; j < 8; j++) val = (val << 1) | bits[i + j];
    dataBytes.push(val);
  }

  // Pad bytes (0xEC, 0x11 alternating)
  const pad = [0xec, 0x11];
  let pIdx = 0;
  while (dataBytes.length < totalDataBytes) {
    dataBytes.push(pad[pIdx % 2]);
    pIdx++;
  }

  // 2. RS Error Correction per block with uneven codeword distribution (ISO/IEC 18004)
  const shortBlockLen = Math.floor(totalDataBytes / numBlocks);
  const numLongBlocks = totalDataBytes % numBlocks;
  const numShortBlocks = numBlocks - numLongBlocks;

  const blocksDc: number[][] = [];
  const blocksEc: number[][] = [];
  let byteOffset = 0;

  for (let b = 0; b < numBlocks; b++) {
    const bLen = b < numShortBlocks ? shortBlockLen : shortBlockLen + 1;
    const bDc = dataBytes.slice(byteOffset, byteOffset + bLen);
    byteOffset += bLen;
    const bEc = rsEncode(bDc, ecPerBlock);
    blocksDc.push(bDc);
    blocksEc.push(bEc);
  }

  // 3. Interleaving data and EC codewords
  const maxDcCount = shortBlockLen + (numLongBlocks > 0 ? 1 : 0);
  const finalCodewords: number[] = [];
  for (let i = 0; i < maxDcCount; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < blocksDc[b].length) {
        finalCodewords.push(blocksDc[b][i]);
      }
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < numBlocks; b++) {
      finalCodewords.push(blocksEc[b][i]);
    }
  }

  // 4. Matrix initialization
  const matrix: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  const isFunc: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));

  const setMod = (r: number, c: number, val: boolean, func = true) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      matrix[r][c] = val;
      if (func) isFunc[r][c] = true;
    }
  };

  // 4.1 Finder patterns with 1-module quiet separator
  const drawFinder = (top: number, left: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const row = top + r;
        const col = left + c;
        if (row >= 0 && row < size && col >= 0 && col < size) {
          const isCore = r >= 0 && r <= 6 && c >= 0 && c <= 6;
          if (!isCore) {
            setMod(row, col, false);
          } else if (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
            setMod(row, col, true);
          } else {
            setMod(row, col, false);
          }
        }
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // 4.2 Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setMod(6, i, i % 2 === 0);
    setMod(i, 6, i % 2 === 0);
  }

  // 4.3 Alignment patterns (for Version >= 2)
  if (alignPos.length > 0) {
    for (const r of alignPos) {
      for (const c of alignPos) {
        if (
          (r < 9 && c < 9) ||
          (r < 9 && c >= size - 9) ||
          (r >= size - 9 && c < 9)
        ) {
          continue;
        }
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const val = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
            setMod(r + dr, c + dc, val);
          }
        }
      }
    }
  }

  // 4.4 Dark module
  setMod(size - 8, 8, true);

  // 4.5 Version information (for Version >= 7) BEFORE data placement so modules are marked isFunc
  if (version >= 7) {
    const verInfo = bchVersionInfo(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((verInfo >> i) & 1) === 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      setMod(r, c, bit);
      setMod(c, r, bit);
    }
  }

  // 4.6 Format information helper (Level L = 01 => (1 << 3) | mask)
  const writeFormatInfo = (target: boolean[][], mask: number, markFunc: boolean) => {
    const fmt = bchFormatInfo((1 << 3) | mask);
    for (let i = 0; i < 15; i++) {
      const bit = ((fmt >> i) & 1) === 1;
      // Vertical placement around top-left & bottom-left
      const vr = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
      target[vr][8] = bit;
      if (markFunc) isFunc[vr][8] = true;

      // Horizontal placement around top-left & top-right
      const hc = i < 8 ? size - 1 - i : i < 9 ? 15 - i : 14 - i;
      target[8][hc] = bit;
      if (markFunc) isFunc[8][hc] = true;
    }
  };
  // Reserve format info modules as function modules before data placement
  writeFormatInfo(matrix, 0, true);

  // 5. Place Data and EC bits in 2-column zigzag (unmasked base matrix)
  const allBits: number[] = [];
  for (const byte of finalCodewords) {
    for (let i = 7; i >= 0; i--) {
      allBits.push((byte >> i) & 1);
    }
  }

  let bitIdx = 0;
  let upwards = true;
  let right = size - 1;

  while (right > 0) {
    if (right === 6) right--; // Skip vertical timing column
    const cols = [right, right - 1];
    const rows = upwards
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const r of rows) {
      for (const c of cols) {
        if (!isFunc[r][c]) {
          const b = bitIdx < allBits.length ? allBits[bitIdx] : 0;
          bitIdx++;
          matrix[r][c] = b === 1;
        }
      }
    }
    upwards = !upwards;
    right -= 2;
  }

  // 6. Select optimal mask pattern (0..7) minimizing ISO/IEC 18004 penalty score
  let bestScore = Infinity;
  let bestMatrix = matrix;

  for (let mask = 0; mask < 8; mask++) {
    const candidate = matrix.map((row) => [...row]);
    writeFormatInfo(candidate, mask, false);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFunc[r][c] && applyMaskBit(mask, r, c)) {
          candidate[r][c] = !candidate[r][c];
        }
      }
    }
    const score = scoreMatrix(candidate);
    if (score < bestScore) {
      bestScore = score;
      bestMatrix = candidate;
    }
  }

  return bestMatrix;
}

export interface QRCodeProps extends React.SVGProps<SVGSVGElement> {
  value: string;
  size?: number;
  margin?: number;
  className?: string;
}

export const QRCode = ({
  value,
  size = 160,
  margin = 4,
  className,
  ...props
}: QRCodeProps) => {
  const matrix = React.useMemo(() => generateQRMatrix(value), [value]);
  const matrixSize = matrix.length;
  const viewBoxSize = matrixSize + margin * 2;

  const path = React.useMemo(() => {
    if (matrixSize === 0) return "";
    let d = "";
    for (let r = 0; r < matrixSize; r++) {
      for (let c = 0; c < matrixSize; c++) {
        if (matrix[r][c]) {
          d += `M${c + margin},${r + margin}h1v1h-1z `;
        }
      }
    }
    return d;
  }, [matrix, matrixSize, margin]);

  if (matrixSize === 0) {
    return (
      <div
        style={{ width: size, height: size }}
        className={`flex items-center justify-center text-xs text-muted-foreground ${className ?? ""}`}
      >
        <span>URL too long for preview</span>
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
      width={size}
      height={size}
      className={className}
      shapeRendering="crispEdges"
      aria-label={`QR code for ${value}`}
      role="img"
      {...props}
    >
      <rect width={viewBoxSize} height={viewBoxSize} fill="white" />
      <path d={path} fill="black" />
    </svg>
  );
};
