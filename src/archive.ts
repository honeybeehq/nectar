import path from "node:path";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, symlink } from "node:fs/promises";
import { NectarError } from "./errors.js";

export const MAX_TREE_BYTES = 1024 * 1024 * 1024;
export const MAX_ENTRIES = 100_000;
const MAX_HEADER_BYTES = 1024 * 1024;
const BLOCK = 512;

export interface ExtractLimits {
  maxBytes: number;
  maxEntries: number;
}

export interface Extracted {
  files: number;
  bytes: number;
}

function refuse(message: string): NectarError {
  return new NectarError("E_USAGE", `Archive refused: ${message}`, { refused: "archive" });
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const size = Buffer.byteLength(body);
  let length = size + 1;
  while (String(length).length + size !== length) length = String(length).length + size;
  return Buffer.from(`${length}${body}`, "utf8");
}

function padding(size: number): Buffer {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

function header(name: string, size: number, type: string, mode: number, linkname = ""): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, "utf8");
  block.write(linkname, 157, 100, "utf8");
  block.write(octal(mode, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii");
  block.write(octal(0, 8), 116, 8, "ascii");
  block.write(octal(size, 12), 124, 12, "ascii");
  block.write(octal(0, 12), 136, 12, "ascii");
  block.fill(" ", 148, 156);
  block.write(type, 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

export function tarEntry(name: string, data: Buffer, mode = 0o644, type = "0", linkname = ""): Buffer[] {
  const parts: Buffer[] = [];
  if (Buffer.byteLength(name) > 99 || !/^[\x20-\x7e]*$/.test(name)) {
    const pax = paxRecord("path", name);
    parts.push(header("././@PaxHeader", pax.length, "x", 0o644), pax, padding(pax.length));
  }
  parts.push(header(name.slice(0, 99).replace(/[^\x20-\x7e]/g, "_"), data.length, type, mode, linkname), data, padding(data.length));
  return parts;
}

export async function packFiles(root: string, files: Array<{ relative: string; name?: string }>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const file of files) {
    const source = path.join(root, file.relative);
    const info = await lstat(source);
    parts.push(...tarEntry((file.name ?? file.relative).split(path.sep).join("/"), await readFile(source), info.mode & 0o111 ? 0o755 : 0o644));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

class ByteReader {
  private chunks: Buffer[] = [];
  private length = 0;
  private done = false;
  private total = 0;

  constructor(
    private readonly iterator: AsyncIterator<unknown>,
    private readonly limit: number,
  ) {}

  private async fill(wanted: number): Promise<void> {
    while (this.length < wanted && !this.done) {
      const next = await this.iterator.next();
      if (next.done === true) {
        this.done = true;
        break;
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
      this.total += chunk.length;
      if (this.total > this.limit) throw refuse(`it unpacks to more than ${this.limit} bytes`);
      this.chunks.push(chunk);
      this.length += chunk.length;
    }
  }

  private consume(count: number): Buffer {
    const all = this.chunks.length === 1 ? (this.chunks[0] as Buffer) : Buffer.concat(this.chunks);
    this.chunks = count < all.length ? [all.subarray(count)] : [];
    this.length -= count;
    return all.subarray(0, count);
  }

  async exact(count: number): Promise<Buffer> {
    await this.fill(count);
    if (this.length < count) throw refuse("it is truncated");
    return this.consume(count);
  }

  async some(max: number): Promise<Buffer> {
    await this.fill(1);
    if (this.length === 0) throw refuse("it is truncated");
    return this.consume(Math.min(max, this.length));
  }

  async drain(): Promise<void> {
    while (!this.done) {
      await this.fill(this.length + 1);
      this.chunks = [];
      this.length = 0;
    }
  }

  async skip(count: number): Promise<void> {
    let left = count;
    while (left > 0) left -= (await this.some(left)).length;
  }
}

function text(block: Buffer, offset: number, width: number): string {
  const field = block.subarray(offset, offset + width);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? width : end).toString("utf8");
}

function number(block: Buffer, offset: number, width: number): number {
  if (((block[offset] ?? 0) & 0x80) !== 0) throw refuse("it uses base-256 sizes");
  const value = text(block, offset, width).trim();
  if (value === "") return 0;
  if (!/^[0-7]+$/.test(value)) throw refuse(`a header field is not octal ('${value}')`);
  return parseInt(value, 8);
}

function checksumOk(block: Buffer): boolean {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 32 : (block[index] ?? 0);
  return sum === number(block, 148, 8);
}

function parsePax(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw refuse("a pax header is malformed");
    const length = Number(data.subarray(offset, space).toString("ascii"));
    if (!Number.isInteger(length) || length <= space - offset || offset + length > data.length) throw refuse("a pax header is malformed");
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals === -1) throw refuse("a pax header is malformed");
    records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

export function entryPath(name: string): string | undefined {
  if (name.includes("\0")) throw refuse("an entry name contains NUL");
  if (name.startsWith("/")) throw refuse(`absolute path '${name}'`);
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  for (const part of parts) {
    if (part === "..") throw refuse(`'..' in '${name}'`);
    if (part.toLowerCase() === ".git") throw refuse(`'${name}' is inside a .git directory`);
  }
  return parts.length === 0 ? undefined : parts.join("/");
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function directories(root: string, relative: string, includeLast: boolean): Promise<void> {
  const parts = relative.split("/");
  const count = includeLast ? parts.length : parts.length - 1;
  let current = root;
  for (let index = 0; index < count; index += 1) {
    current = path.join(current, parts[index] ?? "");
    const info = await lstat(current).catch(() => undefined);
    if (info === undefined) await mkdir(current, { mode: 0o755 });
    else if (info.isSymbolicLink()) throw refuse(`'${relative}' goes through the symlink '${parts.slice(0, index + 1).join("/")}'`);
    else if (!info.isDirectory()) throw refuse(`'${relative}' goes through the file '${parts.slice(0, index + 1).join("/")}'`);
  }
}

const TYPES: Record<string, string> = {
  "1": "hard link",
  "3": "character device",
  "4": "block device",
  "6": "FIFO",
};

export function linksLeaving(tar: Buffer, within: string): Array<{ link: string; target: string }> {
  const leaving: Array<{ link: string; target: string }> = [];
  let pax: Record<string, string> = {};
  for (let offset = 0; offset + BLOCK <= tar.length; ) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const type = String.fromCharCode(block[156] ?? 0).replace("\0", "0");
    const size = pax.size === undefined ? number(block, 124, 12) : Number(pax.size);
    const data = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "g") continue;
    if (type === "x") {
      pax = { ...pax, ...parsePax(data) };
      continue;
    }
    const prefix = text(block, 345, 155);
    const name = (pax.path ?? (prefix === "" ? text(block, 0, 100) : `${prefix}/${text(block, 0, 100)}`)).replace(/\/+$/, "");
    const target = pax.linkpath ?? text(block, 157, 100);
    pax = {};
    if (type !== "2") continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
    const outside = path.posix.isAbsolute(target) || (within === "" ? resolved === ".." || resolved.startsWith("../") : resolved !== within && !resolved.startsWith(`${within}/`));
    if (outside) leaving.push({ link: name, target });
  }
  return leaving;
}

export async function extractTar(source: AsyncIterable<unknown>, destination: string, limits: ExtractLimits = { maxBytes: MAX_TREE_BYTES, maxEntries: MAX_ENTRIES }): Promise<Extracted> {
  const root = await realpath(destination);
  const reader = new ByteReader(source[Symbol.asyncIterator](), limits.maxBytes + limits.maxEntries * BLOCK * 4);
  const links: string[] = [];
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  let longLink: string | undefined;
  let entries = 0;
  let files = 0;
  let bytes = 0;
  for (;;) {
    const block = await reader.exact(BLOCK);
    if (block.every((byte) => byte === 0)) {
      await reader.drain();
      break;
    }
    if (!checksumOk(block)) throw refuse("a header checksum does not match");
    const type = String.fromCharCode(block[156] ?? 0).replace("\0", "0");
    const size = pax.size === undefined ? number(block, 124, 12) : Number(pax.size);
    if (!Number.isSafeInteger(size) || size < 0) throw refuse("an entry has an invalid size");
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      if (size > MAX_HEADER_BYTES) throw refuse("a metadata header is too large");
      const data = (await reader.exact(padded)).subarray(0, size);
      if (type === "x") pax = { ...pax, ...parsePax(data) };
      if (type === "L") longName = text(data, 0, data.length);
      if (type === "K") longLink = text(data, 0, data.length);
      continue;
    }
    const prefix = text(block, 345, 155);
    const name = pax.path ?? longName ?? (prefix === "" ? text(block, 0, 100) : `${prefix}/${text(block, 0, 100)}`);
    const linkname = pax.linkpath ?? longLink ?? text(block, 157, 100);
    const mode = number(block, 100, 8);
    pax = {};
    longName = undefined;
    longLink = undefined;
    entries += 1;
    if (entries > limits.maxEntries) throw refuse(`it has more than ${limits.maxEntries} entries`);
    const known = TYPES[type];
    if (known !== undefined) throw refuse(`'${name}' is a ${known}`);
    if (type !== "0" && type !== "7" && type !== "5" && type !== "2") throw refuse(`'${name}' has unsupported entry type '${type}'`);
    const relative = entryPath(name);
    if (relative === undefined) {
      if (type !== "5") throw refuse("an entry has an empty name");
      await reader.skip(padded);
      continue;
    }
    const target = path.join(root, relative);
    if (type === "5") {
      await directories(root, relative, true);
      await reader.skip(padded);
      continue;
    }
    await directories(root, relative, false);
    if ((await lstat(target).catch(() => undefined)) !== undefined) throw refuse(`'${relative}' appears twice`);
    if (type === "2") {
      if (linkname === "" || linkname.includes("\0") || path.isAbsolute(linkname)) throw refuse(`symlink '${relative}' points to an absolute path`);
      const resolved = path.join(path.dirname(target), linkname);
      if (!inside(resolved, root)) throw refuse(`symlink '${relative}' points outside the archive`);
      if (path.relative(root, resolved).split(path.sep).some((part) => part.toLowerCase() === ".git")) throw refuse(`symlink '${relative}' points into .git`);
      await symlink(linkname, target);
      links.push(relative);
      await reader.skip(padded);
      continue;
    }
    bytes += size;
    if (bytes > limits.maxBytes) throw refuse(`it holds more than ${limits.maxBytes} bytes`);
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode & 0o111 ? 0o755 : 0o644);
    try {
      let left = size;
      while (left > 0) {
        const piece = await reader.some(left);
        await handle.write(piece);
        left -= piece.length;
      }
    } finally {
      await handle.close();
    }
    await reader.skip(padded - size);
    files += 1;
  }
  for (const link of links) {
    const real = await realpath(path.join(root, link)).catch(() => undefined);
    if (real === undefined) throw refuse(`symlink '${link}' does not point to anything in the archive`);
    if (!inside(real, root)) throw refuse(`symlink '${link}' resolves outside the archive`);
  }
  return { files, bytes };
}
